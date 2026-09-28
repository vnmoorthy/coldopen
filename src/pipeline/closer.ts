// Closer: writes a short, honest pitch email. The model only writes the subject and one specific
// sentence about the preview; every promise in the body is fixed text, so nothing can be overstated.

import type { Brand, Business, Env, SiteSpec } from "../types";
import { llmJSON } from "../llm";
import { categoryLabel, isFoodish, placeFor } from "./brand";
import { slopHits } from "./critic";

const MAX_WORDS = 140;

function distancePhrase(biz: Business, env: Env): string {
  const place = placeFor(biz, env);
  const m = place.metersFromHQ;
  if (m === null) return "here in San Francisco";
  if (m <= 320) return "two blocks away";
  if (m <= 800) return "a few blocks away";
  if (m <= 2000) return place.neighborhood !== "San Francisco" ? `nearby in ${place.neighborhood}` : "nearby";
  return "here in San Francisco";
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

function oneLine(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "").slice(0, max).trim() : "";
}

// Claims the model must not make on the business's behalf or about our relationship with them.
const PITCH_BANNED = /\b(love|loved|favorite|favourite|best|amazing|incredible|guarantee|guaranteed|limited time|act now|hurry|only today|customers are|reviews?|rated|award|increase (?:sales|revenue)|more customers|boost)\b|!/i;

export async function writePitch(
  env: Env,
  biz: Business,
  brand: Brand | null,
  site: SiteSpec | null,
  links: { previewUrl?: string; paymentUrl?: string } = {},
): Promise<{ pitch: { subject: string; body: string }; costCents: number; provider: string }> {
  const pub = (env.PUBLIC_URL || "").replace(/\/+$/, "");
  const previewUrl = links.previewUrl || `${pub}/s/${encodeURIComponent(biz.id)}`;
  const label = categoryLabel(biz);
  const where = distancePhrase(biz, env);
  const confirmed = !!brand?.offeringsConfirmed;

  let subject = "";
  let detail = "";
  let costCents = 0;
  let provider = "template";

  const system = `You are Closer at Cold Open. You write the two variable lines of a short, honest cold email to a local business owner.
Plain, warm, specific, zero hype. Never flatter, never claim to be a customer, never promise results, never invent facts.`;

  const prompt = `We built a one-page website preview for ${biz.name}, a ${label}${biz.address ? ` at ${biz.address}` : ""}, before asking them.
What the preview contains:
- headline: ${site?.headline ?? "(n/a)"}
- subheadline: ${site?.subheadline ?? "(n/a)"}
- highlights: ${(site?.highlights || []).map((h) => h.title).join(", ") || "(n/a)"}
- ${site?.offeringsTitle ?? "offerings"}: ${(site?.offerings || []).map((o) => o.name).slice(0, 4).join(", ") || "(n/a)"}${confirmed ? " (taken from their own website)" : " (placeholders marked for the owner to confirm)"}
- hours: ${site?.hoursText && !/owner to confirm/i.test(site.hoursText) ? site.hoursText : "(unknown — do not mention hours)"}
- look: ${brand ? `${brand.vibe}; ${brand.fonts.heading} type; colors ${brand.palette.primary} and ${brand.palette.accent}` : "(n/a)"}

Return JSON:
{
  "subject": "max 60 characters, must contain \"${biz.name}\", plain and specific, no clickbait, no emoji — e.g. \"A website for ${biz.name}, made ${where}\"",
  "detail": "ONE full sentence, 14-26 words, saying concretely what the preview shows for them, e.g. \"It leads with your empanadas, lists your daily 8am–5pm hours, and has directions to 700 2nd Street.\" Describe the site, not the quality of their business."
}
Do not use: love, favorite, best, amazing, guarantee, exclamation marks, results or sales promises.`;

  try {
    const res = await llmJSON<{ subject?: string; detail?: string }>(env, { system, prompt, maxTokens: 300, temperature: 0.6, effort: "low" });
    costCents = res.costCents;
    provider = res.provider;
    subject = oneLine(res.data?.subject, 70);
    detail = oneLine(res.data?.detail, 220);
  } catch (e) {
    console.warn(`[closer] LLM failed for ${biz.id}: ${e instanceof Error ? e.message : e}`);
  }

  if (!subject || PITCH_BANNED.test(subject) || slopHits(subject).length || !subject.toLowerCase().includes(biz.name.toLowerCase().slice(0, 4))) {
    subject = `We built ${biz.name} a website (before asking)`;
  }
  if (!detail || PITCH_BANNED.test(detail) || slopHits(detail).length || countWords(detail) > 30) {
    const bits: string[] = [];
    if (site?.offerings?.length) bits.push(isFoodish(biz) ? "your menu" : "what you offer");
    if (site?.hoursText && !/owner to confirm/i.test(site.hoursText)) bits.push("hours");
    bits.push(biz.address ? `directions to ${biz.address}` : "directions");
    detail = `It's one page in your colors with ${bits.join(", ").replace(/, ([^,]*)$/, " and $1")}.`;
  }
  if (!/[.?]$/.test(detail)) detail += ".";

  const intro = `We're Cold Open, built at a hackathon at Cloudflare HQ, ${where}. We made ${biz.name} a website before asking, because it's easier to react to something real.`;
  const confirm = confirmed ? "" : `Anything marked "owner to confirm" is a placeholder until you tell us the real version.`;
  const offer = `If you want it, $49 gets you the site handed over to you, set up on your own domain, plus a short launch ad.`;
  const exit = `No pressure either way. Reply "remove" and we delete it the same day.`;

  const build = (withConfirm: boolean, withDetail: boolean) =>
    [
      `Hi ${biz.name} team,`,
      "",
      intro,
      "",
      [withDetail ? detail : "", withConfirm ? confirm : ""].filter(Boolean).join(" "),
      "",
      `Preview: ${previewUrl}`,
      "",
      `${offer} ${exit}`,
      "",
      "— Cold Open",
    ]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");

  let body = build(true, true);
  if (countWords(body) > MAX_WORDS) body = build(false, true);
  if (countWords(body) > MAX_WORDS) body = build(false, false);

  return { pitch: { subject: subject.slice(0, 80), body }, costCents, provider };
}
