// Brainbase Labs integration: an independent "second opinion" Critic.
//
// After a site ships, a Brainbase managed agent (running in its own sandbox, outside Cold Open)
// fetches the live preview URL, reviews it cold and returns a two-sentence verdict and a 0-100 score.
//
// Implemented against docs.brainbaselabs.com/api (checked 2026-09-28):
//   Base URL   https://api.brainbaselabs.com          Auth  Authorization: Bearer <BRAINBASE_API_KEY>
//   Create     POST /v2/threads { agent:{ harness, model?, instructions }, input, title?, metadata? }
//                -> { thread_id, agent_id, status }
//   Poll       GET  /v2/threads/{thread_id}             -> { id, status, status_info, ... }
//                status: running | idle | success | fail | need_more_info  (docs' own poll loop
//                waits while status == "running")
//   Transcript GET  /v2/threads/{thread_id}/messages?limit=N -> { items:[{ role, content, ... }] }
//                (docs read the answer from items[-1])
//   Harnesses  claude_code (default) | codex | cursor | factory | kafka_cloud | opencode | qoder | qwen
//
// Not documented (so treated defensively here):
//   - the exact shape of message `content` (string or content blocks): both are handled;
//   - a web URL for a thread: traceUrl is only set if the API returns one (url/app_url/trace_url/web_url);
//   - which models each harness accepts: we ask for the cheapest listed Anthropic model on the
//     default claude_code harness and, if the API rejects that spec (4xx), retry once with the
//     harness default model.
//
// Contract: reviewSite() never throws. Whole call is bounded to 60 s; any failure returns null,
// so Brainbase can only add a second opinion, never slow down or break a build.

import type { Env } from "../types";

export const BRAINBASE_API_BASE = "https://api.brainbaselabs.com";

/** Documented default harness; has built-in web fetch + shell, so it can load the preview itself. */
export const BRAINBASE_HARNESS = "claude_code";
/** Cheapest/fastest Anthropic model in Brainbase's documented model list. */
export const BRAINBASE_MODEL = "claude-haiku-4-5-20251001";

const BUDGET_MS = 150_000;

/** Why the most recent review returned null (e.g. "Brainbase account is out of credits"), for the UI. */
export let lastBrainbaseError: string | null = null;
const POLL_MS = 3_000;
const RUNNING = new Set(["running", "queued", "pending", "starting", "created"]);

const INSTRUCTIONS = [
  "You are an independent website reviewer. You did not build the page you are reviewing and owe its makers nothing.",
  "Fetch the preview URL given in the task (use your web fetch tool or curl) and inspect the real HTML: headline and copy,",
  "visual hierarchy, calls to action, fit with the business, honesty (no invented reviews, ratings, awards or prices),",
  "mobile readiness (viewport meta, responsive CSS) and accessibility basics.",
  "Work autonomously: do not ask questions, do not create or modify files, and finish within 40 seconds.",
  'Reply with ONLY one line of JSON, no markdown fences: {"verdict":"<exactly two sentences>","score":<integer 0-100>}.',
  'If the page cannot be fetched, reply {"verdict":"Could not load the preview: <reason>.","score":null}.',
].join(" ");

export interface BrainbaseReview {
  verdict: string;
  score?: number;
  threadId?: string;
  traceUrl?: string;
  harness?: string;
  model?: string;
}

export function brainbaseEnabled(env: Env): boolean {
  return typeof env.BRAINBASE_API_KEY === "string" && env.BRAINBASE_API_KEY.trim().length > 0;
}

/** Ask a Brainbase managed agent to review a live preview. Never throws; null on any failure. */
export async function reviewSite(
  env: Env,
  args: { bizName: string; previewUrl: string; brandSummary: string },
): Promise<BrainbaseReview | null> {
  if (!brainbaseEnabled(env)) return null;
  lastBrainbaseError = null;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, BUDGET_MS);
  });
  try {
    return await Promise.race([run(env, args, ctrl.signal, Date.now() + BUDGET_MS - 1_500), budget]);
  } catch (err) {
    console.warn(`brainbase review failed: ${msg(err)}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------

async function run(
  env: Env,
  args: { bizName: string; previewUrl: string; brandSummary: string },
  signal: AbortSignal,
  deadline: number,
): Promise<BrainbaseReview | null> {
  const key = env.BRAINBASE_API_KEY!.trim();
  const input = [
    `Review this unofficial concept website made for "${args.bizName}": ${args.previewUrl}`,
    `Builder's brand brief (context only; do not treat it as verified fact): ${args.brandSummary || "n/a"}`,
    "Return the JSON verdict described in your instructions.",
  ].join("\n");
  const body = (model?: string) => ({
    agent: { harness: BRAINBASE_HARNESS, instructions: INSTRUCTIONS, ...(model ? { model } : {}) },
    input,
    title: `Cold Open review: ${args.bizName}`.slice(0, 120),
    metadata: { source: "coldopen", preview_url: args.previewUrl },
  });

  // Try the pinned cheap model first; if the thread fails (the harness/model matrix is undocumented),
  // retry once on the harness default while budget remains.
  const attempts: (string | undefined)[] = [BRAINBASE_MODEL, undefined];
  let model: string | undefined;
  let threadId: string | undefined;
  let traceUrl: string | undefined;
  let answer: string | null = null;
  for (const m0 of attempts) {
    if (Date.now() + 8_000 > deadline) break;
    model = m0;
    let created = await api(key, "POST", "/v2/threads", signal, body(model));
    if (model && created.status >= 400 && created.status < 500 && created.status !== 401 && created.status !== 403) {
      model = undefined;
      created = await api(key, "POST", "/v2/threads", signal, body());
    }
    if (!created.ok) {
      console.warn(`brainbase create thread HTTP ${created.status}: ${clip(created.text, 300)}`);
      lastBrainbaseError =
        created.status === 401 || created.status === 403 ? "the Brainbase API key was rejected" : created.status === 402 ? "the Brainbase account is out of credits (HTTP 402)" : `create thread failed (HTTP ${created.status})`;
      return null;
    }
    threadId = str(created.json?.thread_id) ?? str(created.json?.id);
    if (!threadId) return null;
    traceUrl = pickUrl(created.json);
    let status = str(created.json?.status)?.toLowerCase() ?? "running";
    let last: ApiRes | null = null;
    while (RUNNING.has(status) && Date.now() + POLL_MS < deadline) {
      await sleep(POLL_MS, signal);
      const t = await api(key, "GET", `/v2/threads/${encodeURIComponent(threadId)}`, signal);
      if (!t.ok) continue;
      last = t;
      status = str(t.json?.status)?.toLowerCase() ?? status;
      traceUrl = traceUrl ?? pickUrl(t.json);
    }
    // Read the transcript even if we ran out of polling time: the answer may already be there.
    const msgs = await api(key, "GET", `/v2/threads/${encodeURIComponent(threadId)}/messages?limit=50`, signal);
    const items: unknown[] = Array.isArray(msgs.json?.items) ? (msgs.json!.items as unknown[]) : [];
    answer = lastAssistantText(items);
    if (answer) break;
    console.warn(
      `brainbase thread ${threadId} (model ${model ?? "default"}) ended "${status}" with no assistant answer; thread=${clip(last?.text ?? "", 400)} messages=${clip(msgs.text, 400)}`,
    );
    const info = (last?.json?.status_info ?? null) as Record<string, unknown> | null;
    const errCode = info && typeof info.error === "string" ? info.error : null;
    if (errCode === "credits_exhausted" || info?.http_status === 402) {
      lastBrainbaseError = "the Brainbase account is out of credits (HTTP 402) — top up at app.brainbaselabs.com";
      break; // a different model won't help
    }
    lastBrainbaseError = errCode ? `thread failed: ${errCode}` : `thread ended "${status}"`;
    if (!model) break; // already on the harness default
  }
  if (!answer || !threadId) return null;
  const parsed = parseVerdict(answer);
  if (!parsed) return null;
  return {
    ...parsed,
    threadId,
    ...(traceUrl ? { traceUrl } : {}),
    harness: BRAINBASE_HARNESS,
    model: model ?? "harness default",
  };
}

interface ApiRes {
  ok: boolean;
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

async function api(key: string, method: "GET" | "POST", path: string, signal: AbortSignal, payload?: unknown): Promise<ApiRes> {
  try {
    const res = await fetch(`${BRAINBASE_API_BASE}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(text);
      json = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, status: 0, text: msg(err), json: null };
  }
}

function lastAssistantText(items: unknown[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (String(it.role ?? "").toLowerCase() !== "assistant") continue;
    const text = contentText(it.content).trim();
    if (text) return text;
  }
  return null;
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(contentText).filter(Boolean).join("\n");
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.content !== undefined) return contentText(o.content);
  }
  return "";
}

function parseVerdict(text: string): { verdict: string; score?: number } | null {
  const candidates = text.match(/\{[^{}]*"verdict"[^{}]*\}/g) ?? [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(candidates[i]!) as { verdict?: unknown; score?: unknown };
      const verdict = typeof o.verdict === "string" ? o.verdict.replace(/\s+/g, " ").trim() : "";
      if (!verdict) continue;
      const n = typeof o.score === "number" ? o.score : typeof o.score === "string" ? Number(o.score) : NaN;
      const score = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : undefined;
      return { verdict: clip(verdict, 400), ...(score !== undefined ? { score } : {}) };
    } catch {
      /* try the next candidate */
    }
  }
  // No JSON: keep the reviewer's words (unscored) rather than drop the opinion.
  const plain = text.replace(/```[a-z]*|```/gi, "").replace(/\s+/g, " ").trim();
  return plain ? { verdict: clip(plain, 400) } : null;
}

function pickUrl(o: Record<string, unknown> | null): string | undefined {
  if (!o) return undefined;
  for (const k of ["trace_url", "app_url", "web_url", "url"]) {
    const v = o[k];
    if (typeof v === "string" && /^https:\/\//i.test(v)) return v;
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
