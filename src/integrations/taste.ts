// Taste Labs "Taste Engine" Brand API integration (Archivist + Critic agents).
//
// Implemented against docs.tastelabs.com and its OpenAPI spec (checked 2026-09-28):
//   Base URL     https://api.tastelabs.com            Auth  X-API-Key: <key>
//   Extractor    POST /design/submissions { url }  -> 202 { submission_id, status:"accepted" }
//                GET  /design/submissions/{id}/result?sections=profile,colors,typography
//                     200 (possibly partial) { status, result:{ design_system } } | 409 NOT_READY | 404
//   Verifier     POST /judge/brand-adherence { reference_url, source_url } -> 202 { job_id }
//                GET  /judge/brand-adherence/{job_id}/result
//                     200 { status, score (0..1|null), recommendations[], fixes[] } | 409 NOT_READY | 424 failed
//   Search       POST /search { query, depth:"fast", top_k, filters? } -> 200 { results:[card] }  (synchronous)
//   Errors       { detail: { error: CODE, message } }  (401 UNAUTHORIZED, 402 INSUFFICIENT_CREDITS, ...)
//
// Extraction and verification are asynchronous jobs that take about 3-5 minutes on a fresh URL
// (cache hits are fast). Every function here is bounded to 30 s, so submission and job ids are
// cached (in memory and in the MEDIA KV namespace under "taste:*") and reused: a call that times
// out leaves the job running, and the next call for the same URL picks up the result instead of
// paying for a second job.
//
// Contract: no function in this file throws. Anything unexpected is logged (never the key) and
// the function returns null, so Taste Labs can only ever upgrade a build, never break one.

import type { Brand, Env } from "../types";

export const TASTE_API_BASE = "https://api.tastelabs.com";

const TIMEOUT_MS = 30_000;
const EXTRACT_SECTIONS = "profile,colors,typography";
const KV_PREFIX = "taste:";
const SUBMISSION_TTL_S = 3 * 24 * 3600; // reuse a submission id for 3 days
const BRAND_TTL_S = 7 * 24 * 3600; // completed extraction mapped to Partial<Brand>
const JOB_TTL_S = 6 * 3600; // brand-adherence job records
const INFLIGHT_REUSE_MS = 10 * 60_000; // reuse a still-running verifier job for the same pair
const SAME_HTML_REUSE_MS = 6 * 3600_000; // reuse a finished verdict when the page HTML is unchanged

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface TasteVerdict {
  score: number; // 0-100
  notes: string[];
}

export interface TasteAdherenceStatus {
  status: "pending" | "ready" | "error";
  score?: number; // 0-100, only when ready
  notes?: string[]; // only when ready
  step?: string; // e.g. "extracting", "judging"
  error?: string;
}

export interface TasteSearchCard {
  name: string;
  url: string;
  identity: string;
  reason: string | null;
  match: string | null;
  tags: string[];
  palette: string[]; // uppercase #RRGGBB
  screenshotUrl: string | null;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export function tasteEnabled(env: Env): boolean {
  return Boolean(clean(env.TASTE_API_KEY));
}

/**
 * Extract a brand from a live website with the Taste Engine Extractor and map it onto Brand fields:
 * name, voice (copy tone), vibe (brand signature), keywords, palette (5 roles), fonts (only when
 * both families are served by Google Fonts) and sourceSignals. Never sets offerings, story or tagline.
 * Returns whatever has landed within the wait budget (partial results are allowed), or null.
 */
export async function tasteExtractBrand(
  env: Env,
  url: string,
  opts: { waitMs?: number } = {},
): Promise<Partial<Brand> | null> {
  try {
    if (!tasteEnabled(env)) return null;
    const target = normalizeUrl(url);
    if (!target) return null;
    const deadline = Date.now() + clampWait(opts.waitMs, 3_000);
    const h = await hashKey(target);

    const cached = await kvGetJSON<Partial<Brand>>(env, `${KV_PREFIX}brand:${h}`);
    if (cached && typeof cached === "object") return cached;

    let subId = memSubmissions.get(h) ?? (await kvGetText(env, `${KV_PREFIX}sub:${h}`));
    const reused = Boolean(subId);
    if (!subId) {
      subId = await submitExtraction(env, target, h, deadline);
      if (!subId) return null;
    }

    // Leave ~2 s after polling to verify fonts against Google Fonts.
    let outcome = await pollExtraction(env, subId, deadline - 2_000);
    if (outcome.kind === "missing" && reused && deadline - Date.now() > 8_000) {
      // Cached id no longer exists on Taste's side: forget it and submit once more.
      await forgetSubmission(env, h);
      subId = await submitExtraction(env, target, h, deadline);
      if (!subId) return null;
      outcome = await pollExtraction(env, subId, deadline - 2_000);
    }
    if (outcome.kind === "failed" || outcome.kind === "missing") {
      await forgetSubmission(env, h);
      if (outcome.error) console.warn(`[taste] extraction failed for ${target}: ${outcome.error}`);
      return null;
    }
    if (!outcome.ds) return null;

    const mapped = await mapDesignSystem(outcome.ds, outcome.kind === "completed", deadline);
    if (!mapped) return null;
    if (outcome.kind === "completed" && mapped.settled) {
      await kvPutJSON(env, `${KV_PREFIX}brand:${h}`, mapped.brand, BRAND_TTL_S);
    }
    return mapped.brand;
  } catch (err) {
    console.warn(`[taste] tasteExtractBrand error: ${errMessage(err)}`);
    return null;
  }
}

/**
 * Start (or reuse) an extraction without waiting for it, so the result is ready by the time
 * tasteExtractBrand is called for the same URL. Returns true when a submission exists.
 */
export async function tastePrewarmBrand(env: Env, url: string): Promise<boolean> {
  try {
    if (!tasteEnabled(env)) return false;
    const target = normalizeUrl(url);
    if (!target) return false;
    const h = await hashKey(target);
    if (await kvGetText(env, `${KV_PREFIX}brand:${h}`)) return true;
    if (memSubmissions.get(h) ?? (await kvGetText(env, `${KV_PREFIX}sub:${h}`))) return true;
    return Boolean(await submitExtraction(env, target, h, Date.now() + 10_000));
  } catch (err) {
    console.warn(`[taste] tastePrewarmBrand error: ${errMessage(err)}`);
    return false;
  }
}

/**
 * Score a generated page against the business's real brand with the Taste Engine Verifier.
 * The Verifier crawls two live URLs, so this needs:
 *   - `url`: the public URL of the generated page (e.g. `${PUBLIC_URL}/s/${id}`), already serving `html`;
 *   - a reference URL: `referenceUrl` (the business website) or an http(s) URL found in brand.sourceSignals.
 * Returns { score 0-100, notes } when a verdict is available within the wait budget, else null.
 * A job that is still running is reused by later calls for the same pair (no duplicate charge).
 */
export async function tasteScore(
  env: Env,
  input: { brand: Brand; html: string; url?: string; referenceUrl?: string; waitMs?: number },
): Promise<TasteVerdict | null> {
  try {
    if (!tasteEnabled(env)) return null;
    const rawSource = clean(input?.url);
    // Accept a path like "/s/<id>" and resolve it against the deployed origin.
    const source = normalizeUrl(rawSource.startsWith("/") && env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/+$/, "")}${rawSource}` : rawSource);
    const reference = normalizeUrl(input?.referenceUrl ?? "") ?? referenceFromBrand(input?.brand);
    if (!source || !reference) return null;
    if (new URL(source).host === new URL(reference).host) return null; // judging a site against itself says nothing

    const deadline = Date.now() + clampWait(input.waitMs, 3_000);
    const pair = await hashKey(`${reference}\n${source}`);
    const htmlHash = await hashKey(typeof input.html === "string" ? input.html : "");
    const kvKey = `${KV_PREFIX}job:${pair}`;

    let rec: JobRecord | null = memJobs.get(pair) ?? (await kvGetJSON<JobRecord>(env, kvKey));
    if (rec && !reusable(rec, htmlHash)) rec = null;
    if (!rec) {
      const started = await startAdherence(env, reference, source, deadline);
      if (!started) return null;
      rec = { jobId: started, htmlHash, at: Date.now(), done: false };
      await rememberJob(env, pair, rec);
    }

    let delay = 2_000;
    for (;;) {
      const st = await tasteGetAdherence(env, rec.jobId, { deadline });
      if (st?.status === "ready" && typeof st.score === "number") {
        if (!rec.done) await rememberJob(env, pair, { ...rec, done: true });
        return { score: st.score, notes: st.notes ?? [] };
      }
      if (st?.status === "error") {
        await forgetJob(env, pair);
        if (st.error) console.warn(`[taste] verifier job ${rec.jobId} failed: ${st.error}`);
        return null;
      }
      if (deadline - Date.now() < delay + 1_000) return null; // still running: a later call picks it up
      await sleep(delay);
      delay = Math.min(delay * 1.5, 5_000);
    }
  } catch (err) {
    console.warn(`[taste] tasteScore error: ${errMessage(err)}`);
    return null;
  }
}

/**
 * Fire-and-forget verifier start, for background scoring after a site is live
 * (pair it with tasteGetAdherence on a schedule). Returns the Taste job id, or null.
 */
export async function tasteStartAdherence(
  env: Env,
  input: { referenceUrl: string; sourceUrl: string },
): Promise<{ jobId: string } | null> {
  try {
    if (!tasteEnabled(env)) return null;
    const reference = normalizeUrl(input?.referenceUrl ?? "");
    const source = normalizeUrl(input?.sourceUrl ?? "");
    if (!reference || !source) return null;
    const jobId = await startAdherence(env, reference, source, Date.now() + TIMEOUT_MS);
    return jobId ? { jobId } : null;
  } catch (err) {
    console.warn(`[taste] tasteStartAdherence error: ${errMessage(err)}`);
    return null;
  }
}

/**
 * One status check of a verifier job (no waiting). Returns null when Taste could not be reached
 * (transient: check again later); 'error' is terminal.
 */
export async function tasteGetAdherence(
  env: Env,
  jobId: string,
  opts: { deadline?: number } = {},
): Promise<TasteAdherenceStatus | null> {
  try {
    if (!tasteEnabled(env)) return null;
    const id = clean(jobId);
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) return { status: "error", error: "Invalid Taste Labs job id." };
    const deadline = Math.min(opts.deadline ?? Infinity, Date.now() + TIMEOUT_MS);
    const r = await call(env, "GET", `/judge/brand-adherence/${encodeURIComponent(id)}/result`, { deadline });
    if (!r) return null;

    if (r.status === 200) {
      const v = r.body ?? {};
      const status = clean(v.status);
      if (status === "failed") return { status: "error", error: clean(v.error) || "Taste Labs verifier job failed." };
      const score = toPercent(v.score);
      if (status === "completed" && score !== null) return { status: "ready", score, notes: verdictNotes(v) };
      if (status === "completed") return { status: "error", error: "Taste Labs verifier completed without a score." };
      return { status: "pending", step: status || undefined };
    }
    if (r.status === 409) return { status: "pending", step: stepFromMessage(errorInfo(r.body).message) };
    if (r.status === 424) return { status: "error", error: errorInfo(r.body).message || "Taste Labs verifier job failed." };
    if (r.status === 404) return { status: "error", error: "Taste Labs has no record of this verifier job." };
    if (r.status >= 500 || r.status === 429) return null;
    logHttp("verifier result", r);
    return { status: "error", error: httpSummary(r) };
  } catch (err) {
    console.warn(`[taste] tasteGetAdherence error: ${errMessage(err)}`);
    return null;
  }
}

/**
 * Search the Taste Labs curated brand corpus for an aesthetic ("warm neighborhood bakery, hand-drawn,
 * cream and terracotta"). Synchronous, fast depth. Useful as inspiration for businesses with no website.
 */
export async function tasteSearch(
  env: Env,
  query: string,
  opts: { topK?: number; category?: string } = {},
): Promise<TasteSearchCard[] | null> {
  try {
    if (!tasteEnabled(env)) return null;
    const q = clean(query).replace(/\s+/g, " ").slice(0, 400);
    if (q.length < 2) return null;
    const body: Record<string, unknown> = {
      query: q,
      depth: "fast",
      top_k: Math.max(1, Math.min(30, Math.round(opts.topK ?? 6))),
    };
    const industry = industryFor(opts.category);
    if (industry) body.filters = { industry };

    const r = await call(env, "POST", "/search", { body, deadline: Date.now() + TIMEOUT_MS });
    if (!r) return null;
    if (r.status !== 200) {
      logHttp("search", r);
      return null;
    }
    const results = Array.isArray(r.body?.results) ? r.body.results : [];
    return results
      .map((c: any): TasteSearchCard | null => {
        const url = normalizeUrl(clean(c?.url));
        if (!url) return null;
        const palette = uniq([...hexList(c?.palette?.primary), ...hexList(c?.palette?.secondary)]).slice(0, 8);
        return {
          name: clean(c?.brand_name) || new URL(url).hostname.replace(/^www\./, ""),
          url,
          identity: clean(c?.identity_paragraph).slice(0, 600),
          reason: clean(c?.reason) || null,
          match: clean(c?.match) || null,
          tags: strList(c?.tags).slice(0, 12),
          palette,
          screenshotUrl: /^https:\/\//i.test(clean(c?.screenshot_url)) ? clean(c?.screenshot_url) : null,
        };
      })
      .filter((c: TasteSearchCard | null): c is TasteSearchCard => c !== null);
  } catch (err) {
    console.warn(`[taste] tasteSearch error: ${errMessage(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

interface TasteResponse {
  status: number;
  body: any;
}

async function call(
  env: Env,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; deadline: number },
): Promise<TasteResponse | null> {
  const remaining = opts.deadline - Date.now();
  if (remaining < 400) return null;
  const headers: Record<string, string> = { "X-API-Key": clean(env.TASTE_API_KEY), Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(TASTE_API_BASE + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(Math.min(remaining, TIMEOUT_MS)),
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { detail: text.slice(0, 200) }; // 500s are plain text
    }
    return { status: res.status, body };
  } catch (err) {
    console.warn(`[taste] ${method} ${path.split("?")[0]} failed: ${errMessage(err)}`);
    return null;
  }
}

function errorInfo(body: any): { code: string; message: string } {
  const d = body?.detail;
  if (typeof d === "string") return { code: "", message: d.slice(0, 240) };
  if (Array.isArray(d)) {
    const msg = d.map((x: any) => [Array.isArray(x?.loc) ? x.loc.join(".") : "", clean(x?.msg)].filter(Boolean).join(": ")).join("; ");
    return { code: "VALIDATION", message: msg.slice(0, 240) };
  }
  return { code: clean(d?.error), message: clean(d?.message).slice(0, 240) };
}

function httpSummary(r: TasteResponse): string {
  const { code, message } = errorInfo(r.body);
  switch (r.status) {
    case 401:
      return "Taste Labs rejected the API key (401). Check TASTE_API_KEY.";
    case 402:
      return "Taste Labs account is out of credits (402).";
    case 403:
      return "This Taste Labs key is not allowed to call that endpoint (403).";
    default:
      return `Taste Labs HTTP ${r.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`;
  }
}

function logHttp(what: string, r: TasteResponse): void {
  console.warn(`[taste] ${what}: ${httpSummary(r)}`);
}

// ---------------------------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------------------------

const memSubmissions = new Map<string, string>();

async function submitExtraction(env: Env, target: string, h: string, deadline: number): Promise<string | null> {
  // The submit gets at least 8 s even when the caller's wait budget is shorter.
  const r = await call(env, "POST", "/design/submissions", { body: { url: target }, deadline: Math.max(deadline, Date.now() + 8_000) });
  if (!r) return null;
  if (r.status !== 202 && r.status !== 200) {
    logHttp(`extract ${target}`, r);
    return null;
  }
  const id = clean(r.body?.submission_id);
  if (!id) return null;
  memSubmissions.set(h, id);
  await kvPutText(env, `${KV_PREFIX}sub:${h}`, id, SUBMISSION_TTL_S);
  return id;
}

async function forgetSubmission(env: Env, h: string): Promise<void> {
  memSubmissions.delete(h);
  await kvDelete(env, `${KV_PREFIX}sub:${h}`);
}

type ExtractOutcome =
  | { kind: "completed"; ds: any }
  | { kind: "pending"; ds: any | null }
  | { kind: "failed"; ds: null; error?: string }
  | { kind: "missing"; ds: null; error?: string };

async function pollExtraction(env: Env, id: string, deadline: number): Promise<ExtractOutcome> {
  let ds: any = null;
  let useSections = true;
  let delay = 1_500;
  for (;;) {
    const qs = useSections ? `?sections=${EXTRACT_SECTIONS}` : "";
    const r = await call(env, "GET", `/design/submissions/${encodeURIComponent(id)}/result${qs}`, { deadline });
    if (!r) return { kind: "pending", ds };
    if (r.status === 200) {
      const status = clean(r.body?.status);
      const d = r.body?.result?.design_system;
      if (d && typeof d === "object") ds = d;
      if (status === "completed") return { kind: "completed", ds };
      if (status === "failed") return { kind: "failed", ds: null, error: clean(r.body?.error) || undefined };
    } else if (r.status === 404) {
      return { kind: "missing", ds: null };
    } else if (r.status === 422 && useSections) {
      useSections = false; // section filter rejected (alpha API drift): poll the full document instead
      continue;
    } else if (r.status !== 409) {
      logHttp("extract result", r);
      return { kind: "pending", ds };
    }
    if (deadline - Date.now() < delay + 600) return { kind: "pending", ds };
    await sleep(delay);
    delay = Math.min(delay * 1.5, 4_000);
  }
}

/**
 * Map a (possibly partial) Taste design_system onto Brand fields. `settled` is false when a font
 * check could not finish in time, so the mapping is not cached and a later call can apply the fonts.
 */
async function mapDesignSystem(
  ds: any,
  complete: boolean,
  deadline: number,
): Promise<{ brand: Partial<Brand>; settled: boolean } | null> {
  const out: Partial<Brand> = {};
  let settled = true;
  const signals: string[] = [`Taste Labs Brand API extraction${complete ? "" : " (partial, still running)"}`];

  const profile = isObj(ds?.profile) ? ds.profile : null;
  if (profile) {
    const name = clean(profile.brand_name).slice(0, 80);
    if (name) {
      out.name = name;
      signals.push(`Taste Labs brand name "${name}"`);
    }
    const tones = strList(profile.copy_tone).slice(0, 4).map((t) => t.toLowerCase());
    if (tones.length) {
      out.voice = tones.join(", ");
      signals.push(`Taste Labs copy tone: ${out.voice}`);
    }
    const style = isObj(profile.style_classification) ? profile.style_classification : null;
    const primaryStyle = clean(style?.primary_style);
    const secondaryStyle = clean(style?.secondary_style);
    const signature = clean(profile.brand_signature);
    if (signature) out.vibe = signature.length > 160 ? `${signature.slice(0, 159).trimEnd()}…` : signature;
    else if (primaryStyle) out.vibe = [primaryStyle, secondaryStyle].filter(Boolean).join(", ").toLowerCase();
    if (primaryStyle) signals.push(`Taste Labs style: ${[primaryStyle, secondaryStyle].filter(Boolean).join(" / ")}`);

    const vl = isObj(profile.visual_language) ? profile.visual_language : null;
    const keywords = uniq(
      [...strList(vl?.keywords), primaryStyle, secondaryStyle, clean(profile.industry).replace(/_/g, " ")]
        .map((k) => clean(k).toLowerCase())
        .filter((k) => k.length > 1 && k.length <= 40),
    ).slice(0, 10);
    if (keywords.length) out.keywords = keywords;
  }

  const palette = pickPalette(ds?.colors);
  if (palette) {
    out.palette = palette.palette;
    signals.push(
      `Taste Labs palette: ${Object.entries(palette.palette)
        .map(([role, hex]) => `${role} ${hex}${palette.derived.includes(role) ? " (derived)" : ""}`)
        .join(", ")}`,
    );
  }

  const fonts = pickFonts(ds?.typography);
  if (fonts.heading || fonts.body) {
    const heading = fonts.heading ?? fonts.body!;
    const body = fonts.body ?? fonts.heading!;
    const [hOk, bOk] = await Promise.all([onGoogleFonts(heading, deadline), onGoogleFonts(body, deadline)]);
    if (hOk && bOk) out.fonts = { heading, body };
    if (!googleFontCache.has(heading) || !googleFontCache.has(body)) settled = false;
    signals.push(
      `Taste Labs typography: headings "${heading}", body "${body}"` + (hOk && bOk ? "" : " (not both on Google Fonts, not applied)"),
    );
  }

  if (Object.keys(out).length === 0) return null;
  out.sourceSignals = signals;
  return { brand: out, settled };
}

// ----- colors -----

interface Swatch {
  hex: string;
  label: string;
  core: boolean; // from colors.baseline
}

function collectSwatches(colors: any): Swatch[] {
  const out: Swatch[] = [];
  const seen = new Set<string>();
  const add = (entry: any, core: boolean) => {
    if (typeof entry === "string") entry = { hex: entry };
    if (!isObj(entry)) return;
    const hex = normHex(entry.hex ?? entry.value ?? entry.color);
    if (!hex || seen.has(hex)) return;
    let alpha = typeof entry.alpha === "number" ? entry.alpha : null;
    if (alpha !== null && alpha > 1) alpha = alpha / 100; // ASSUMPTION: alpha is 0-1; tolerate 0-100
    if (alpha !== null && alpha < 0.85) return; // translucent overlays are not palette roles
    seen.add(hex);
    const label = [entry.name, entry.type, entry.role, entry.usage, entry.description, ...strList(entry.rules?.when_to_use)]
      .map(clean)
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    out.push({ hex, label, core });
  };

  if (isObj(colors)) {
    // Documented shape: colors.baseline[] and colors.secondary[] of named palettes.
    for (const e of arr(colors.baseline)) add(e, true);
    for (const e of arr(colors.secondary)) add(e, false);
    if (out.length === 0) {
      // ASSUMPTION: alpha API drift. Walk the section for any { hex } objects or hex strings.
      walk(colors, 4, (v) => add(v, true));
    }
  } else if (Array.isArray(colors)) {
    for (const e of colors) add(e, true);
  }
  return out;
}

function pickPalette(colors: any): { palette: Brand["palette"]; derived: string[] } | null {
  const sw = collectSwatches(colors);
  if (sw.length < 2) return null;
  const used = new Set<string>();
  const derived: string[] = [];
  const free = () => sw.filter((s) => !used.has(s.hex));
  const take = (s: Swatch | undefined): string | null => {
    if (!s) return null;
    used.add(s.hex);
    return s.hex;
  };
  const byLabel = (re: RegExp, ok: (s: Swatch) => boolean = () => true) => free().find((s) => re.test(s.label) && ok(s));

  // Background: a labelled background/surface colour, else the most extreme neutral.
  const background =
    take(byLabel(/\b(background|backgrounds|bg|canvas|page|surface|base)\b/, (s) => chroma(s.hex) < 0.35)) ??
    take([...free()].sort((a, b) => neutralScore(b) - neutralScore(a))[0])!;

  // Text: a labelled text colour with readable contrast, else the highest-contrast swatch, else derived.
  let text =
    take(byLabel(/\b(text|body|copy|foreground|ink|paragraph|heading|headings|headline|typography)\b/, (s) => contrast(s.hex, background) >= 4.5)) ??
    take([...free()].filter((s) => contrast(s.hex, background) >= 4.5).sort((a, b) => contrast(b.hex, background) - contrast(a.hex, background))[0]);
  if (!text) {
    text = luminance(background) > 0.4 ? "#111111" : "#F7F7F5";
    derived.push("text");
  }

  // Primary: labelled brand / CTA colour, else the most chromatic remaining swatch (core palette first).
  let primary =
    take(byLabel(/\b(primary|brand|cta|button|buttons|action|actions|main|key)\b/)) ??
    take([...free()].sort((a, b) => chroma(b.hex) + (b.core ? 0.05 : 0) - (chroma(a.hex) + (a.core ? 0.05 : 0)))[0]);
  if (!primary) {
    primary = text; // monochrome brand: the ink is the brand colour
    derived.push("primary");
  }

  // Accent: labelled accent/link/highlight, else a chromatic swatch at least 30 degrees of hue away.
  let accent =
    take(byLabel(/\b(accent|accents|highlight|link|links|hover|focus|badge|tag|pop)\b/)) ??
    take(free().filter((s) => chroma(s.hex) > 0.12 && hueDistance(s.hex, primary!) >= 30).sort((a, b) => chroma(b.hex) - chroma(a.hex))[0]) ??
    take(free().sort((a, b) => chroma(b.hex) - chroma(a.hex))[0]);
  if (!accent) {
    accent = primary;
    derived.push("accent");
  }

  // Secondary: labelled secondary/muted/border colour, else whatever is left, else a primary tint.
  let secondary =
    take(byLabel(/\b(secondary|muted|subtle|border|borders|divider|neutral|support|supporting)\b/)) ?? take(free()[0]);
  if (!secondary) {
    secondary = mix(primary, background, 0.35);
    derived.push("secondary");
  }

  return { palette: { primary, secondary, accent, background, text }, derived };
}

// ----- typography -----

const GENERIC_FAMILIES =
  /^(sans-serif|serif|monospace|cursive|fantasy|system-ui|emoji|math|fangsong|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|-apple-system|blinkmacsystemfont|segoe ui|segoe ui emoji|segoe ui symbol|apple color emoji|noto color emoji|helvetica|helvetica neue|arial|inherit|initial|unset|revert|default)$/i;

function parseFamily(v: unknown): string | null {
  const s = clean(v);
  if (!s || s.startsWith("var(")) return null;
  for (const part of s.split(",")) {
    let f = part.trim().replace(/^["']|["']$/g, "").trim();
    f = f.replace(/\s+(Variable|VF)$/i, "").trim();
    if (!f || f.startsWith("var(") || GENERIC_FAMILIES.test(f)) continue;
    if (/\bicons?\b|awesome|fallback|\bsymbols?\b|\bemoji\b/i.test(f)) continue;
    if (f.length < 2 || f.length > 48 || !/^[A-Za-z0-9 .&'-]+$/.test(f)) continue;
    return f;
  }
  return null;
}

function familiesIn(group: any): string[] {
  const out: string[] = [];
  const variants = Array.isArray(group) ? group : isObj(group) ? Object.values(group) : [];
  for (const v of variants) {
    if (!isObj(v)) continue;
    const cands = [
      (v as any).technical?.font_family_css,
      (v as any).specs?.font_family,
      (v as any).specs?.family,
      (v as any).font_family,
      (v as any).family,
      (v as any).font,
    ];
    for (const c of cands) {
      const f = parseFamily(c);
      if (f) {
        out.push(f);
        break;
      }
    }
  }
  return out;
}

function pickFonts(typo: any): { heading?: string; body?: string } {
  if (!isObj(typo)) return {};
  // Documented groups: titles / paragraphs / labels / others, each a list of variants.
  const heading = [...familiesIn(typo.titles), ...familiesIn(typo.headings)][0];
  const body = [...familiesIn(typo.paragraphs), ...familiesIn(typo.body)][0];
  if (heading || body) return { heading, body };
  const rest = [...familiesIn(typo.labels), ...familiesIn(typo.others)];
  if (rest.length) return { heading: rest[0], body: rest[1] ?? rest[0] };
  // ASSUMPTION: alpha API drift. Take any font_family-like string in the section.
  const found: string[] = [];
  walk(typo, 5, (v, key) => {
    if (typeof v === "string" && key && /font_?family|family/i.test(key)) {
      const f = parseFamily(v);
      if (f) found.push(f);
    }
  });
  return found.length ? { heading: found[0], body: found[1] ?? found[0] } : {};
}

const googleFontCache = new Map<string, boolean>();

/** Brand.fonts must be Google Fonts families, so only apply faces Google actually serves. */
async function onGoogleFonts(family: string, deadline: number): Promise<boolean> {
  const cached = googleFontCache.get(family);
  if (cached !== undefined) return cached;
  const remaining = deadline - Date.now();
  if (remaining < 500) return false;
  try {
    const res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&display=swap`, {
      signal: AbortSignal.timeout(Math.min(4_000, remaining)),
    });
    const ok = res.ok && (await res.text()).includes("@font-face");
    googleFontCache.set(family, ok);
    return ok;
  } catch {
    return false; // unknown: do not cache, do not apply
  }
}

// ---------------------------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------------------------

interface JobRecord {
  jobId: string;
  htmlHash: string;
  at: number;
  done: boolean;
}

const memJobs = new Map<string, JobRecord>();

function reusable(rec: JobRecord, htmlHash: string): boolean {
  const age = Date.now() - rec.at;
  if (rec.htmlHash === htmlHash) return age < SAME_HTML_REUSE_MS;
  // Different HTML (a newer site version): only piggyback on a job that is still running, so a fast
  // critic loop does not pay for a new 3-5 minute job per version.
  return !rec.done && age < INFLIGHT_REUSE_MS;
}

async function rememberJob(env: Env, pair: string, rec: JobRecord): Promise<void> {
  memJobs.set(pair, rec);
  await kvPutJSON(env, `${KV_PREFIX}job:${pair}`, rec, JOB_TTL_S);
}

async function forgetJob(env: Env, pair: string): Promise<void> {
  memJobs.delete(pair);
  await kvDelete(env, `${KV_PREFIX}job:${pair}`);
}

async function startAdherence(env: Env, reference: string, source: string, deadline: number): Promise<string | null> {
  const r = await call(env, "POST", "/judge/brand-adherence", {
    body: { reference_url: reference, source_url: source },
    deadline: Math.max(deadline, Date.now() + 8_000),
  });
  if (!r) return null;
  if (r.status !== 202 && r.status !== 200) {
    logHttp("verifier start", r);
    return null;
  }
  return clean(r.body?.job_id) || null;
}

function toPercent(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // Documented as 0..1. ASSUMPTION: the alpha API could switch to 0..100; accept both.
  const pct = v <= 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function verdictNotes(v: any): string[] {
  const notes: string[] = [];
  for (const rec of strList(v?.recommendations).slice(0, 5)) notes.push(cap(rec, 240));
  for (const fix of arr(v?.fixes).slice(0, 3)) {
    const t = describeFix(fix);
    if (t) notes.push(t);
  }
  if (notes.length === 0) notes.push("Taste Labs Verifier reported no brand-adherence issues.");
  return notes;
}

function describeFix(f: any): string | null {
  if (!isObj(f)) return null;
  const scalar = (x: unknown) => (typeof x === "string" || typeof x === "number" ? String(x).trim() : "");
  const action = clean(f.action).replace(/_/g, " ");
  const target = [f.property, f.token, f.name, f.selector, f.element, f.component].map(scalar).find(Boolean) ?? "";
  const from = [f.from, f.from_value, f.current, f.current_value].map(scalar).find(Boolean) ?? "";
  const to = [f.to_value, f.to, f.value, f.target, f.hex, f.token_value].map(scalar).find(Boolean) ?? "";
  if (!action && !target && !to) return null;
  let s = `Fix${action ? ` (${action})` : ""}`;
  if (target) s += `: ${target}`;
  if (from && to) s += ` ${from} → ${to}`;
  else if (to) s += ` → ${to}`;
  return cap(s, 200);
}

function stepFromMessage(message: string): string | undefined {
  // e.g. "Brand adherence job is extracting"
  const m = /\bis\s+([a-z_]+)\s*$/i.exec(message);
  return m ? m[1].toLowerCase() : undefined;
}

function referenceFromBrand(brand: Brand | undefined): string | null {
  for (const s of strList(brand?.sourceSignals)) {
    const m = /https?:\/\/[^\s"'<>()]+/i.exec(s);
    const u = m ? normalizeUrl(m[0].replace(/[.,;]+$/, "")) : null;
    if (u) return u;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------------------------

const TASTE_INDUSTRIES = new Set([
  "food", "beverage", "restaurant", "hospitality", "beauty", "wellness", "fashion", "photography",
  "architecture", "real_estate", "healthcare", "entertainment", "media", "design", "e_commerce",
]);

/** OSM category -> Taste industry filter. Filters are hard constraints, so only map clear cases. */
function industryFor(category: string | undefined): string | null {
  const c = clean(category).toLowerCase();
  if (!c) return null;
  if (TASTE_INDUSTRIES.has(c)) return c;
  if (/restaurant|fast_food|food_court|diner|pizza|sushi|ramen|taqueria/.test(c)) return "restaurant";
  if (/cafe|coffee|tea|juice|bar|pub|brewery|wine|biergarten|cocktail/.test(c)) return "beverage";
  if (/bakery|deli|pastry|confectionery|ice_cream|butcher|greengrocer|grocery/.test(c)) return "food";
  if (/hotel|hostel|guest_house|motel/.test(c)) return "hospitality";
  if (/hairdresser|beauty|nail|cosmetics|barber|salon/.test(c)) return "beauty";
  if (/fitness|gym|yoga|spa|massage|pilates/.test(c)) return "wellness";
  if (/clothes|boutique|shoes|fashion|tailor/.test(c)) return "fashion";
  return null;
}

function hexList(v: unknown): string[] {
  const out: string[] = [];
  for (const x of arr(v)) {
    const h = normHex(typeof x === "string" ? x : (x as any)?.hex);
    if (h) out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function cap(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strList(v: unknown): string[] {
  if (typeof v === "string") return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return arr(v).map(clean).filter(Boolean);
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function walk(v: unknown, depth: number, visit: (v: unknown, key?: string) => void, key?: string): void {
  if (depth < 0 || v === null || v === undefined) return;
  if (Array.isArray(v)) {
    for (const x of v) walk(x, depth - 1, visit, key);
    return;
  }
  if (isObj(v)) {
    if ("hex" in v) visit(v, key);
    for (const [k, x] of Object.entries(v)) {
      if (k === "shades") continue; // tints of a palette entry, not separate roles
      if (typeof x === "string") visit(x, k);
      else walk(x, depth - 1, visit, k);
    }
    return;
  }
  visit(v, key);
}

function clampWait(v: number | undefined, min: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : TIMEOUT_MS;
  return Math.max(min, Math.min(TIMEOUT_MS, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" || err.name === "AbortError" ? "timed out" : err.message;
  return String(err);
}

function normalizeUrl(raw: string): string | null {
  let s = clean(raw);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    if (!host.includes(".") || host === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

async function hashKey(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ----- KV (best effort; MEDIA is shared with images, so everything lives under "taste:") -----

async function kvGetText(env: Env, key: string): Promise<string | null> {
  try {
    return (await env.MEDIA?.get(key, "text")) ?? null;
  } catch {
    return null;
  }
}

async function kvGetJSON<T>(env: Env, key: string): Promise<T | null> {
  try {
    return ((await env.MEDIA?.get(key, "json")) as T | null) ?? null;
  } catch {
    return null;
  }
}

async function kvPutText(env: Env, key: string, value: string, ttl: number): Promise<void> {
  try {
    await env.MEDIA?.put(key, value, { expirationTtl: Math.max(60, ttl) });
  } catch {
    /* cache only */
  }
}

async function kvPutJSON(env: Env, key: string, value: unknown, ttl: number): Promise<void> {
  await kvPutText(env, key, JSON.stringify(value), ttl);
}

async function kvDelete(env: Env, key: string): Promise<void> {
  try {
    await env.MEDIA?.delete(key);
  } catch {
    /* cache only */
  }
}

// ----- colour math -----

function normHex(v: unknown): string | null {
  const s = clean(v).replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) return `#${s.split("").map((c) => c + c).join("")}`.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s}`.toUpperCase();
  if (/^[0-9a-f]{8}$/i.test(s)) {
    // #RRGGBBAA: keep only (nearly) opaque colours
    return parseInt(s.slice(6, 8), 16) >= 217 ? `#${s.slice(0, 6)}`.toUpperCase() : null;
  }
  return null;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function chroma(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

function neutralScore(s: Swatch): number {
  return (1 - chroma(s.hex)) * Math.abs(luminance(s.hex) - 0.5) * 2 + (s.core ? 0.1 : 0);
}

function hue(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function hueDistance(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

function mix(a: string, b: string, t: number): string {
  const [ra, ga, ba] = rgb(a);
  const [rb, gb, bb] = rgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ra, rb)}${c(ga, gb)}${c(ba, bb)}`.toUpperCase();
}
