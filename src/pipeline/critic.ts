// Critic: the taste gate. LLM rubric (brand fidelity 30, specificity 25, clarity 20, voice 15, CTA 10)
// minus a deterministic 6 points per banned phrase and small structural/fact-check deductions.

import type { Brand, Business, Env, ScoreVersion, SiteSpec } from "../types";
import { llmJSON } from "../llm";
import { categoryLabel, getSiteEvidence, placeFor } from "./brand";

// ---------------------------------------------------------------------------------------------
// Slop: phrases that mark copy as generic AI/marketing filler.
// `fix`: a safe in-place replacement, or null when the sentence should be rewritten/dropped.

interface Slop {
  label: string;
  re: RegExp;
  fix: string | null;
}

const SLOP: Slop[] = [
  { label: "elevate", re: /\belevat(?:e|es|ed|ing)\b/gi, fix: null },
  { label: "unleash", re: /\bunleash(?:es|ed|ing)?\b/gi, fix: null },
  { label: "nestled", re: /\bnestled\b/gi, fix: "" },
  { label: "culinary journey", re: /\bculinary (?:journey|adventure|experience|delights?|escape)\b/gi, fix: "meal" },
  { label: "tantalize", re: /\btantali[sz](?:e|es|ed|ing)\b/gi, fix: "" },
  { label: "mouthwatering", re: /\bmouth[- ]?watering\b/gi, fix: "" },
  { label: "look no further", re: /\blook no further\b/gi, fix: null },
  { label: "in the heart of", re: /\bin the (?:very )?heart of\b/gi, fix: "in" },
  { label: "whether you're", re: /\bwhether you(?:'|’)?re\b/gi, fix: null },
  { label: "embark", re: /\bembark(?:s|ed|ing)?\b/gi, fix: null },
  { label: "delve", re: /\bdelv(?:e|es|ed|ing)\b/gi, fix: "dig" },
  { label: "symphony of flavors", re: /\bsymphony of (?:flavou?rs?|tastes?)\b/gi, fix: "flavor" },
  { label: "testament", re: /\btestament to\b/gi, fix: null },
  { label: "a haven", re: /\ba (?:true |real )?haven\b/gi, fix: "a spot" },
  { label: "seamless", re: /\bseamless(?:ly)?\b/gi, fix: "" },
  { label: "unparalleled", re: /\bunparalleled\b/gi, fix: "" },
  { label: "world-class", re: /\bworld[- ]class\b/gi, fix: "" },
  { label: "best-kept secret", re: /\bbest[- ]kept secret\b/gi, fix: null },
  { label: "hidden gem", re: /\bhidden gem\b/gi, fix: null },
  { label: "indulge", re: /\bindulg(?:e|es|ed|ing)\b/gi, fix: "dig in" },
  { label: "delectable", re: /\bdelectable\b/gi, fix: "" },
  { label: "exquisite", re: /\bexquisite\b/gi, fix: "" },
  { label: "gastronomic", re: /\bgastronomic(?:al)?\b/gi, fix: "" },
  { label: "feast for the senses", re: /\bfeast for (?:the|your|all) senses\b/gi, fix: null },
  { label: "tastebuds", re: /\btaste ?buds\b/gi, fix: null },
  { label: "like no other", re: /\blike no other\b/gi, fix: "" },
  { label: "second to none", re: /\bsecond to none\b/gi, fix: "" },
  { label: "something for everyone", re: /\bsomething for everyone\b/gi, fix: null },
  { label: "one-stop shop", re: /\bone[- ]stop[- ]shop\b/gi, fix: null },
  { label: "take it to the next level", re: /\b(?:to )?the next level\b/gi, fix: null },
  { label: "game-changer", re: /\bgame[- ]chang(?:er|ing)\b/gi, fix: null },
  { label: "unforgettable", re: /\bunforgettable\b/gi, fix: "" },
  { label: "rich tapestry", re: /\b(?:rich )?tapestry\b/gi, fix: null },
  { label: "treasure trove", re: /\btreasure trove\b/gi, fix: null },
  { label: "boasts", re: /\bboast(?:s|ing)\b/gi, fix: "has" },
  { label: "state-of-the-art", re: /\bstate[- ]of[- ]the[- ]art\b/gi, fix: "" },
  { label: "perfect blend", re: /\bperfect (?:blend|balance|harmony) of\b/gi, fix: null },
  { label: "passion for", re: /\b(?:a |our )?passion for\b/gi, fix: null },
  { label: "passionate about", re: /\bpassionate about\b/gi, fix: null },
  { label: "we pride ourselves", re: /\bwe pride ourselves\b/gi, fix: null },
  { label: "crafted with love", re: /\b(?:crafted|made) with (?:love|care and love|passion)\b/gi, fix: "made" },
  { label: "labor of love", re: /\blabou?r of love\b/gi, fix: null },
  { label: "curated", re: /\bcurated\b/gi, fix: "chosen" },
  { label: "vibrant", re: /\bvibrant\b/gi, fix: "" },
  { label: "bespoke", re: /\bbespoke\b/gi, fix: "custom" },
  { label: "unique experience", re: /\bunique (?:experience|atmosphere|ambiance|ambience)\b/gi, fix: null },
  { label: "experience the", re: /\bexperience the (?:best|magic|taste|flavou?rs?|joy|art)\b/gi, fix: null },
  { label: "discover the", re: /\bdiscover the (?:magic|secret|best|taste|joy|art|world)\b/gi, fix: null },
  { label: "cozy atmosphere", re: /\b(?:cozy|warm|inviting|welcoming) (?:atmosphere|ambiance|ambience)\b/gi, fix: null },
  { label: "warm and welcoming", re: /\bwarm and (?:welcoming|inviting)\b/gi, fix: null },
  { label: "go-to destination", re: /\bgo[- ]to (?:destination|spot for all)\b/gi, fix: null },
  { label: "culinary", re: /\bculinary\b/gi, fix: "" },
  { label: "gourmet", re: /\bgourmet\b/gi, fix: "" },
  { label: "savor every bite", re: /\bsavou?r every (?:bite|sip|moment)\b/gi, fix: null },
  { label: "you won't be disappointed", re: /\byou won(?:'|’)?t be disappointed\b/gi, fix: null },
  { label: "a must-try", re: /\ba must[- ](?:try|visit)\b/gi, fix: null },
];

/** Banned phrases found in `text` (one entry per distinct phrase, in list order). */
export function slopHits(text: string): string[] {
  const t = String(text || "");
  const hits: string[] = [];
  for (const s of SLOP) {
    s.re.lastIndex = 0;
    if (s.re.test(t) && !hits.includes(s.label)) hits.push(s.label);
    s.re.lastIndex = 0;
  }
  // "culinary journey" already covers "culinary"
  if (hits.includes("culinary journey")) return hits.filter((h) => h !== "culinary");
  return hits;
}

function tidy(s: string): string {
  return s
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*([,.])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/^\s*[,;:]\s*/, "")
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

/** Removes banned phrases deterministically. Sentences whose slop can't be patched in place are
 *  dropped when `allowDrop` and other sentences remain; otherwise the phrase is cut. */
export function scrubSlop(text: string, allowDrop = true): string {
  if (!text) return text;
  if (!slopHits(text).length) return text;
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const out: string[] = [];
  for (const sentence of sentences) {
    let s = sentence;
    let drop = false;
    for (const rule of SLOP) {
      rule.re.lastIndex = 0;
      if (!rule.re.test(s)) continue;
      rule.re.lastIndex = 0;
      if (rule.fix === null) {
        if (allowDrop && sentences.length > 1) {
          drop = true;
          break;
        }
        s = s.replace(rule.re, "");
      } else {
        s = s.replace(rule.re, rule.fix);
      }
      rule.re.lastIndex = 0;
    }
    if (!drop) out.push(s);
  }
  const joined = tidy(out.join(" "));
  return joined.length >= 3 ? joined : tidy(text.replace(/\s+/g, " "));
}

// ---------------------------------------------------------------------------------------------

export function specText(spec: SiteSpec): string {
  return [
    spec.headline,
    spec.subheadline,
    spec.about,
    ...(spec.highlights || []).flatMap((h) => [h.title, h.text]),
    spec.offeringsTitle,
    ...(spec.offerings || []).flatMap((o) => [o.name, o.description]),
    spec.ctaLabel,
    spec.seo?.title,
    spec.seo?.description,
  ]
    .filter(Boolean)
    .join("\n");
}

const UNSUPPORTED =
  /\b(since (?:19|20)\d\d|est\.? (?:19|20)\d\d|established in|founded in|family[- ]owned|family[- ]run|award[- ]winning|awards?|voted|michelin|five[- ]star|5[- ]star|top[- ]rated|highly rated|reviews?|famous|legendary|world[- ]famous|best in (?:town|the city|sf|san francisco|the bay)|#1|number one|free delivery|delivery|delivered|reservations?|order online|signature|house[- ]made|homemade|hand[- ]?made|made from scratch|from scratch|organic|locally[- ]sourced|farm[- ]to[- ]table|fresh daily|baked daily|roasted (?:on[- ]site|in[- ]house)|walk[- ]ins?|take[- ]?out|takeaway|patio|outdoor seating|wi-?fi|free parking|catering|happy hour|d[eé]cor|interiors?|murals?)\b/gi;

// Evidence that supports a claim even when worded differently (OSM tags, site copy).
const CLAIM_SYNONYMS: [RegExp, RegExp][] = [
  [/^(delivery|delivered|free delivery)$/, /\bdeliver|delivery yes/],
  [/^(reservations?)$/, /\breserv/],
  [/^(order online)$/, /\border/],
  [/^(take ?out|take out|to go|takeaway)$/, /takeaway (?:yes|only)|take ?out|to go/],
  [/^(patio|outdoor seating)$/, /outdoor seating yes|patio|outdoor/],
  [/^(wi ?fi)$/, /internet access (?:wlan|yes)|wi ?fi/],
  [/^(hand ?made|house made|homemade|made from scratch|from scratch)$/, /hand ?made|hand crafted|handcrafted|house made|homemade|from scratch/],
  [/^(walk ins?)$/, /walk ins?/],
];

function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9#$ ]+/g, " ").replace(/\s+/g, " ");
}

const words = (s: string) => (s || "").trim().split(/\s+/).filter(Boolean).length;

interface Check {
  deduct: number;
  note: string;
}

/** Claims in `text` that nothing we read supports (same evidence rules as the fact check below).
 *  The Builder uses this on revisions so a fixed claim can't sneak back in under new wording. */
export function unsupportedClaims(biz: Business, brand: Brand, text: string): string[] {
  const ev = getSiteEvidence(biz.id);
  const evidence = norm(
    [ev?.title, ev?.description, ev?.ogDescription, ...(ev?.headings || []), ev?.text, brand.story, JSON.stringify(biz.osmTags || {})].filter(Boolean).join(" "),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(UNSUPPORTED)) {
    const key = norm(m[0]).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (evidence.includes(key)) continue;
    const syn = CLAIM_SYNONYMS.find(([re]) => re.test(key));
    if (syn && syn[1].test(evidence)) continue;
    out.push(m[0]);
  }
  return out;
}

function structuralChecks(env: Env, biz: Business, brand: Brand, spec: SiteSpec): Check[] {
  const checks: Check[] = [];
  const ev = getSiteEvidence(biz.id);
  const evidence = norm(
    [ev?.title, ev?.description, ev?.ogDescription, ...(ev?.headings || []), ev?.text, brand.story, JSON.stringify(biz.osmTags || {})].filter(Boolean).join(" "),
  );
  const all = specText(spec);

  const hw = words(spec.headline);
  if (hw > 9) checks.push({ deduct: 3, note: `Headline "${spec.headline}" runs ${hw} words — cut it to 8 or fewer so it lands in one glance.` });
  if (norm(spec.headline).trim() === norm(biz.name).trim()) {
    checks.push({ deduct: 2, note: `Headline only repeats the name "${biz.name}" — the name is already in the nav; say what they do and where.` });
  }
  const sw = words(spec.subheadline);
  if (sw > 28) checks.push({ deduct: 2, note: `Subheadline is ${sw} words — tighten to one sentence under 22 words.` });
  if ((spec.highlights || []).length !== 3) checks.push({ deduct: 4, note: `Needs exactly 3 highlights (has ${(spec.highlights || []).length}).` });
  if ((spec.offerings || []).length < 3) checks.push({ deduct: 3, note: `List at least 3 offerings (has ${(spec.offerings || []).length}).` });
  if (!brand.offeringsConfirmed && (spec.offerings || []).some((o) => o.price)) {
    checks.push({ deduct: 10, note: "Prices are shown but the menu is not confirmed from their site — remove every price." });
  }
  const bangs = (all.match(/!/g) || []).length;
  if (bangs > 1) checks.push({ deduct: 2, note: `${bangs} exclamation marks — confident copy doesn't shout; keep at most one.` });
  if (/^(learn more|click here|submit|get started|read more|discover more|explore|contact)$/i.test((spec.ctaLabel || "").trim())) {
    checks.push({ deduct: 3, note: `CTA "${spec.ctaLabel}" is generic — use a verb that fits a ${categoryLabel(biz)} (e.g. "Get directions", "Call the shop").` });
  }

  // Location specificity: street or neighborhood should appear somewhere visible.
  const place = placeFor(biz, env);
  const street = (biz.address || "").replace(/^\d+[A-Za-z]?\s+/, "").split(",")[0].replace(/\b(street|st|avenue|ave|boulevard|blvd|road|rd|way|plaza)\b\.?/gi, "").trim();
  const locTerms = [street, place.neighborhood !== "San Francisco" ? place.neighborhood : "", place.landmark || "", "south beach", "soma", "mission bay", "oracle park", "ballpark"].filter(
    (t) => t && t.length > 2,
  );
  const visible = norm([spec.headline, spec.subheadline, spec.about, ...(spec.highlights || []).map((h) => `${h.title} ${h.text}`)].join(" "));
  if (locTerms.length && !locTerms.some((t) => visible.includes(norm(t).trim()))) {
    checks.push({
      deduct: 3,
      note: `Copy never says where it is — work in ${street ? `"${street}"` : ""}${street && place.neighborhood !== "San Francisco" ? " or " : ""}${place.neighborhood !== "San Francisco" ? `"${place.neighborhood}"` : ""} naturally.`,
    });
  }

  // Fact check: claims we could not have read anywhere.
  let unsupported = 0;
  const seen = new Set<string>();
  for (const m of all.matchAll(UNSUPPORTED)) {
    const claim = m[0];
    const key = norm(claim).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (evidence.includes(key)) continue;
    const syn = CLAIM_SYNONYMS.find(([re]) => re.test(key));
    if (syn && syn[1].test(evidence)) continue;
    if (unsupported++ >= 3) break;
    const line = all.split("\n").find((l) => l.toLowerCase().includes(claim.toLowerCase())) || claim;
    checks.push({ deduct: 6, note: `Unsupported claim "${claim}" in "${line.slice(0, 90)}" — nothing we read says this. Cut it or replace it with a fact.` });
  }
  return checks;
}

// ---------------------------------------------------------------------------------------------
// Rubric as a weighted pass/fail checklist. Binary judgments are far more consistent across models
// than free 0-30 scores; the score is computed here, so notes and score always agree.

interface RubricCheck {
  id: string;
  dim: "brandFidelity" | "specificity" | "clarity" | "voice" | "cta";
  points: number;
  q: string;
}

function rubricChecks(biz: Business, brand: Brand, hasSiteText: boolean): RubricCheck[] {
  const label = categoryLabel(biz);
  return [
    // brand fidelity — 30
    { id: "B1", dim: "brandFidelity", points: 10, q: "Every factual claim (dishes, services, history, seating, décor, distances, transit, sourcing) is supported by BUSINESS FACTS or the site excerpt. The brand vibe/voice are design direction, not facts about the place. Anything else is invented." },
    { id: "B2", dim: "brandFidelity", points: 8, q: hasSiteText ? "Uses at least two concrete details that come from their own website text (real item names, phrases, services) — not just name, category and address." : "Uses the facts we do have (category/cuisine, street, neighborhood, hours if known) in a way that feels specific to this place rather than a template." },
    { id: "B3", dim: "brandFidelity", points: 6, q: `The tone matches the stated brand voice: "${brand.voice}".` },
    { id: "B4", dim: "brandFidelity", points: 6, q: "Nothing would make the owner wince: no wrong facts, no awkward claims about them, no copy that misrepresents what they sell." },
    // specificity — 25
    { id: "S1", dim: "specificity", points: 9, q: `The headline contains something only true of ${biz.name} (a real item, a real detail, or their street combined with what makes them different) — not a generic "${label} on <street>" line.` },
    { id: "S2", dim: "specificity", points: 8, q: `No sentence could be pasted unchanged onto a different ${label}; generic filler like "We serve X cuisine" or "great food" fails this.` },
    { id: "S3", dim: "specificity", points: 8, q: "Each of the three highlights carries a concrete noun (an item, a street, a time, a material), not an abstraction." },
    // clarity — 20
    { id: "C1", dim: "clarity", points: 6, q: "The headline is 8 words or fewer and says what + where at a glance." },
    { id: "C2", dim: "clarity", points: 5, q: "The subheadline adds new information instead of repeating the headline." },
    { id: "C3", dim: "clarity", points: 5, q: "The three highlights say three different things (no two repeat the location or the same idea)." },
    { id: "C4", dim: "clarity", points: 4, q: "The about text is 2-3 clean full sentences that don't repeat the other sections." },
    // voice — 15
    { id: "V1", dim: "voice", points: 8, q: "Reads like a confident human copywriter: no filler, no puffery, no generic adjectives, no clichés, no exclamation marks." },
    { id: "V2", dim: "voice", points: 7, q: "Sentences are complete, varied and natural; nothing clunky, robotic, or fragmentary." },
    // CTA — 10
    { id: "A1", dim: "cta", points: 10, q: "The CTA label is a specific, inviting visit/find-us action that fits this business (the button scrolls to address, hours and directions), not generic and not promising ordering, booking or delivery." },
  ];
}

interface CheckAnswer {
  pass?: boolean | string | number;
  ok?: boolean | string;
  result?: string;
  fix?: string;
  note?: string;
}

function passed(a: CheckAnswer | boolean | string | undefined | null): boolean | null {
  if (a === undefined || a === null) return null;
  const v = typeof a === "object" ? (a.pass ?? a.ok ?? a.result) : a;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v > 0;
  if (typeof v === "string") {
    if (/^(true|yes|pass|passed|ok|y)$/i.test(v.trim())) return true;
    if (/^(false|no|fail|failed|n)$/i.test(v.trim())) return false;
  }
  return null;
}

function fixOf(a: CheckAnswer | boolean | string | undefined | null): string {
  return a && typeof a === "object" ? String(a.fix || a.note || "").replace(/\s+/g, " ").trim() : "";
}

export async function critique(
  env: Env,
  biz: Business,
  brand: Brand,
  spec: SiteSpec,
): Promise<{ version: ScoreVersion; costCents: number }> {
  const hits = slopHits(specText(spec));
  const checks = structuralChecks(env, biz, brand, spec);
  const place = placeFor(biz, env);
  const ev = getSiteEvidence(biz.id);
  const checklist = rubricChecks(biz, brand, !!ev && ev.text.length > 200);

  const draft = {
    theme: spec.theme,
    headline: spec.headline,
    subheadline: spec.subheadline,
    about: spec.about,
    highlights: spec.highlights,
    offeringsTitle: spec.offeringsTitle,
    offerings: spec.offerings,
    ctaLabel: spec.ctaLabel,
    seo: spec.seo,
  };

  const system = `You are Critic, the taste gate at Cold Open. You are a demanding senior brand copywriter and art director reviewing a one-page site draft for a real small business before it is shown to the owner.
You are tough but fair: you reward concrete, verifiable specifics in the business's own voice and you punish anything generic, padded, or invented. You never inflate scores.`;

  const prompt = `BUSINESS FACTS
- name: ${biz.name}
- what: ${categoryLabel(biz)}${biz.osmTags?.cuisine ? ` (cuisine: ${biz.osmTags.cuisine})` : ""}
- where: ${biz.address ?? "address unknown"}, ${place.phrase}
- hours: ${biz.openingHours ? `from OpenStreetMap (${biz.openingHours}) — treat as verified` : "unknown (the site says owner to confirm — that's correct)"}
- website read: ${ev ? `yes (${ev.finalUrl})` : biz.website ? "no (could not load)" : "no website"}

BRAND KIT (from Archivist)
- tagline: ${brand.tagline}
- voice: ${brand.voice}
- vibe: ${brand.vibe}
- palette: ${Object.entries(brand.palette).map(([k, v]) => `${k} ${v}`).join(", ")}; fonts: ${brand.fonts.heading} / ${brand.fonts.body}
- menu confirmed from their site: ${brand.offeringsConfirmed ? "yes" : "NO — we don't know their dishes. Generic category items (e.g. \"Tacos\", \"Espresso drinks\") are correct here; any specific or 'signature' dish is invented. Never suggest dish names."}
- story: ${brand.story}
- evidence actually read: ${brand.sourceSignals.join("; ")}
${ev?.prices?.length ? `- prices printed on their own site: ${ev.prices.join(" ")} (offering prices that match these are real)` : ""}
${ev?.text ? `- excerpt of their own site text: """${ev.text.slice(0, 1500)}"""` : ""}

SITE DRAFT v${spec.version}
${JSON.stringify(draft, null, 1)}

Judge the draft against this checklist. Be strict: answer "pass": true only if you would bet the owner and a senior editor both agree; when in doubt, fail it. Typical first drafts fail 3-5 of these checks. Flat, template sentences such as "It is located on King Street." or "The bar offers drinks and snacks." fail S2 and V2.
${checklist.map((c) => `- ${c.id}: ${c.q}`).join("\n")}

For every failed check, "fix" must quote the exact offending text in double quotes and say concretely what to write instead, e.g. Headline "Great food, great vibes" is generic — name the thing: "Empanadas and cortados on 2nd Street".
Your rewrites must obey the same rules as the copy: only facts listed above (never invent dishes, distances, transit, history or superlatives like "best"), and no clichés such as "in the heart of", "nestled", "hidden gem", "cozy", "vibrant", "perfect for". The hours line is generated from OpenStreetMap — don't critique it. The banned-word list is checked separately.

Return:
{ "checks": { ${checklist.map((c) => `"${c.id}": { "pass": true, "fix": "" }`).join(", ")} } }`;

  let rubric = 0;
  let notes: string[] = [];
  let provider = "heuristic";
  let costCents = 0;
  try {
    const res = await llmJSON<{ checks?: Record<string, CheckAnswer>; [k: string]: unknown }>(env, {
      system,
      prompt,
      maxTokens: 1200,
      temperature: 0.1,
      effort: "low",
      prefer: "smart",
    });
    costCents = res.costCents;
    provider = res.provider;
    const raw = (res.data || {}) as Record<string, unknown>;
    const answers = (raw.checks && typeof raw.checks === "object" ? raw.checks : raw) as Record<string, CheckAnswer>;
    let answered = 0;
    const failed: { c: RubricCheck; fix: string }[] = [];
    rubric = 0;
    for (const c of checklist) {
      const a = answers[c.id] ?? answers[c.id.toLowerCase()];
      const p = passed(a);
      if (p !== null) answered++;
      if (p === false) failed.push({ c, fix: fixOf(a) });
      else rubric += c.points; // unanswered checks get the benefit of the doubt
    }
    if (answered < Math.ceil(checklist.length * 0.6)) throw new Error(`critic answered ${answered}/${checklist.length} checks`);
    notes = failed
      .sort((x, y) => y.c.points - x.c.points)
      .map(({ c, fix }) => fix || `Not yet: ${c.q}`)
      .map((n) => n.replace(/\s+/g, " ").trim())
      .filter((n) => n.length > 8)
      // A note that suggests a banned phrase or an unsupported claim would teach the Builder to get worse.
      .filter((n) => !slopHits(n.replace(/"[^"]*"/, "")).length && !/\b(best|famous|award|legendary)\b/i.test(n.replace(/^[^"]*"[^"]*"/, "")))
      .slice(0, 6);
  } catch (e) {
    console.warn(`[critic] LLM rubric unavailable for ${biz.id}: ${e instanceof Error ? e.message : e}`);
    // Heuristic fallback: structure + banned phrases only, clearly labeled as such.
    rubric = 86;
    provider = "heuristic";
    notes = ["Rubric model unavailable — this score only reflects structure, fact checks and banned phrases."];
  }

  const structural = checks.reduce((a, c) => a + c.deduct, 0);
  const score = Math.max(0, Math.min(100, Math.round(rubric - 6 * hits.length - structural)));
  const allNotes = [...checks.map((c) => c.note), ...notes];
  const dedup: string[] = [];
  for (const n of allNotes) if (!dedup.some((d) => d.toLowerCase() === n.toLowerCase())) dedup.push(n);

  return {
    version: {
      version: spec.version,
      score,
      notes: dedup.slice(0, 8),
      slopHits: hits,
      provider,
      at: Date.now(),
    },
    costCents,
  };
}
