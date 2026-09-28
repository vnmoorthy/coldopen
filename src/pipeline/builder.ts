// Builder: composes the SiteSpec (copy + structure) for one business. On revisions it receives the
// Critic's notes and must visibly address each one.

import type { Brand, Business, Env, SiteSpec, SiteTheme } from "../types";
import { llmJSON } from "../llm";
import { categoryLabel, cuisineList, getSiteEvidence, isFoodish, placeFor } from "./brand";
import { scrubSlop, slopHits, unsupportedClaims } from "./critic";

// ---------------------------------------------------------------------------------------------
// Theme

export function pickTheme(brand: Brand, biz: Business): SiteTheme {
  const text = `${brand.vibe} ${brand.voice} ${(brand.keywords || []).join(" ")}`.toLowerCase();
  const count = (re: RegExp) => (text.match(re) || []).length;
  const bold = count(/\b(bold|loud|neon|punk|street|energetic|electric|industrial|urban|graffiti|sports?|games?|arcade|rooftop|club|late[- ]night|dive|rowdy|brash|rock|retro|pop|bright|high[- ]energy|lively|party|cheeky|irreverent|gritty)\b/g);
  const warm = count(/\b(warm|cozy|cosy|rustic|homey|homestyle|family|sunlit|sunny|comfort|earthy|mediterranean|soft|friendly|garden|handmade|farm|hearth|homemade|neighborly|neighbourly|welcoming|sweet|gentle|golden|terracotta)\b/g);
  const editorial = count(/\b(elegant|refined|minimal|minimalist|modern|upscale|polished|editorial|quiet|clean|design|gallery|sleek|sophisticated|chef|tasting|natural wine|seasonal|precise|considered|understated|architectural|japanese|nordic|literary|calm)\b/g);
  const cat = (biz.category || "").toLowerCase();
  const byCategory: SiteTheme = /^(bar|pub|nightclub|biergarten|games|sports|tattoo)$/.test(cat)
    ? "bold"
    : /^(cafe|bakery|ice_cream|pastry|confectionery|florist|deli|coffee|tea)$/.test(cat)
      ? "warm"
      : "editorial";
  const best = Math.max(bold, warm, editorial);
  if (best === 0) return byCategory;
  const winners: SiteTheme[] = [];
  if (bold === best) winners.push("bold");
  if (warm === best) winners.push("warm");
  if (editorial === best) winners.push("editorial");
  return winners.includes(byCategory) ? byCategory : winners[0];
}

// ---------------------------------------------------------------------------------------------
// Opening hours -> human text

const DAY: Record<string, string> = { mo: "Mon", tu: "Tue", we: "Wed", th: "Thu", fr: "Fri", sa: "Sat", su: "Sun" };

function humanTime(t: string): string | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h >= 24) h -= 24;
  if (h === 0 && min === 0) return "midnight";
  if (h === 12 && min === 0) return "noon";
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${min ? `:${String(min).padStart(2, "0")}` : ""}${suffix}`;
}

function humanDays(d: string): string | null {
  const s = d.trim().toLowerCase();
  if (s === "mo-su" || s === "mo-su,ph") return "Daily";
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (p === "ph" || p === "sh") continue;
    const r = p.match(/^([a-z]{2})(?:-([a-z]{2}))?$/);
    if (!r || !DAY[r[1]] || (r[2] && !DAY[r[2]])) return null;
    out.push(r[2] ? `${DAY[r[1]]}–${DAY[r[2]]}` : DAY[r[1]]);
  }
  return out.length ? out.join(", ") : null;
}

/** "Mo-Fr 07:00-16:00; Sa 08:00-13:00" -> "Mon–Fri 7am–4pm · Sat 8am–1pm". */
export function humanizeHours(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return "Hours — owner to confirm";
  const s = raw.trim();
  if (/^24\/7$/.test(s)) return "Open 24 hours, every day";
  const rules = s.split(";").map((r) => r.trim()).filter(Boolean);
  const out: string[] = [];
  for (const rule of rules) {
    if (/^(ph|sh)\b/i.test(rule)) continue;
    const m = rule.match(/^((?:[A-Za-z]{2}(?:-[A-Za-z]{2})?)(?:\s*,\s*[A-Za-z]{2}(?:-[A-Za-z]{2})?)*)?\s*(.*)$/);
    if (!m) return s.slice(0, 200);
    const days = m[1] ? humanDays(m[1].replace(/\s+/g, "")) : "Daily";
    const rest = (m[2] || "").trim();
    if (!days) return s.slice(0, 200);
    if (/^(off|closed)$/i.test(rest)) {
      out.push(`${days} closed`);
      continue;
    }
    const spans = rest.split(",").map((x) => x.trim()).filter(Boolean);
    const times: string[] = [];
    for (const span of spans) {
      const t = span.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/);
      if (!t) return s.slice(0, 200);
      const a = humanTime(t[1]);
      const b = humanTime(t[2]);
      if (!a || !b) return s.slice(0, 200);
      times.push(`${a}–${b}`);
    }
    if (!times.length) return s.slice(0, 200);
    out.push(`${days} ${times.join(", ")}`);
  }
  // Open days first, closed days last ("Tue–Sun 8am–3pm · Mon closed").
  const open = out.filter((x) => !x.endsWith(" closed"));
  const closed = out.filter((x) => x.endsWith(" closed"));
  const ordered = [...open, ...closed];
  return open.length ? ordered.join(" · ").slice(0, 200) : "Hours — owner to confirm";
}

// ---------------------------------------------------------------------------------------------

const CTA_BANNED = /\b(order|book|reserve|reservation|deliver|delivery|buy|shop now|sign up|subscribe|call|download|learn more|click|submit)\b/i;

function defaultCta(biz: Business): string {
  const cat = (biz.category || "").toLowerCase();
  const cuisines = cuisineList(biz);
  if (cat === "cafe" || cat === "coffee" || cuisines.includes("coffee")) return "Come by for coffee";
  if (cat === "bar" || cat === "pub" || cat === "biergarten") return "Meet us at the bar";
  if (cat === "bakery" || cat === "pastry") return "Visit the counter";
  if (cat === "ice_cream") return "Come get a scoop";
  if (cat === "restaurant" || cat === "fast_food" || cat === "food_court") return "Plan your visit";
  if (isFoodish(biz)) return "Stop in";
  if (/^(massage|beauty|hairdresser|barber|tattoo|dry_cleaning|laundry|optician|fitness_centre|yoga|car_repair|photographer)$/.test(cat)) return "Plan a visit";
  return "Visit the shop";
}

function defaultOfferingsTitle(biz: Business): string {
  const cat = (biz.category || "").toLowerCase();
  if (cat === "cafe" || cat === "coffee") return "On the counter";
  if (cat === "bar" || cat === "pub") return biz.osmTags?.["cuisine"] ? "Food & drinks" : "Behind the bar";
  if (cat === "bakery" || cat === "pastry") return "From the oven";
  if (cat === "ice_cream") return "In the case";
  if (isFoodish(biz)) return "From the kitchen";
  if (/^(massage|beauty|hairdresser|barber|tattoo|dry_cleaning|laundry|optician|car_repair)$/.test(cat)) return "Services";
  return "In the shop";
}

function s(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  let t = v.replace(/\s+/g, " ").trim().replace(/^["“]+|["”]+$/g, "");
  if (t.length > max) {
    const cut = t.slice(0, max);
    const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(", "));
    t = (at > max * 0.6 ? cut.slice(0, at + 1) : cut.replace(/\s+\S*$/, "")).trim();
  }
  return t.replace(/[\s,;:–—-]+$/, "").trim();
}

function streetOf(biz: Business): string {
  return (biz.address || "").replace(/^\d+[A-Za-z]?\s+/, "").split(",")[0].trim();
}

interface LlmSite {
  headline?: string;
  subheadline?: string;
  about?: string;
  highlights?: { title?: string; text?: string }[];
  offeringsTitle?: string;
  offerings?: { name?: string; description?: string; price?: string }[];
  ctaLabel?: string;
  seo?: { title?: string; description?: string };
}

/** Without a model, a revision can still honor the Critic's fact-check notes: every sentence that
 *  carries a flagged claim ("Unsupported claim "X" …") is removed or the phrase is cut. */
function applyClaimFixes(d: LlmSite, feedback: string[]): LlmSite {
  const claims = feedback
    .map((n) => n.match(/Unsupported claim "([^"]+)"/i)?.[1])
    .filter((c): c is string => !!c && c.length > 1)
    .map((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
  if (!claims.length) return d;
  const fix = (t: string | undefined): string => {
    if (!t) return t || "";
    const sentences = t.match(/[^.!?]+[.!?]*\s*/g) || [t];
    const kept = sentences.filter((x) => !claims.some((re) => re.test(x)));
    if (kept.length) return kept.join("").trim();
    let out = t;
    for (const re of claims) out = out.replace(re, "");
    return out.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
  };
  return {
    ...d,
    subheadline: fix(d.subheadline),
    about: fix(d.about),
    highlights: (d.highlights || []).map((h) => ({ title: h.title, text: fix(h.text) })),
    offerings: (d.offerings || []).map((o) => ({ ...o, description: fix(o.description) })),
  };
}

/** Template copy used when every model is unavailable. Only states facts we hold. */
function deterministicDraft(env: Env, biz: Business, brand: Brand, hoursText: string): LlmSite {
  const place = placeFor(biz, env);
  const label = categoryLabel(biz);
  const street = streetOf(biz);
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const article = /^[aeiou]/i.test(label) ? "An" : "A";
  const hood = place.neighborhood !== "San Francisco" ? place.neighborhood : "San Francisco";
  const headline = street ? `${article} ${label} on ${street}` : `${article} ${label} in ${hood}`;
  const near = place.landmark ? `, a short walk from ${place.landmark}` : "";
  const hoursKnown = !hoursText.includes("owner to confirm");
  const simpleHours = hoursKnown && hoursText.split(" · ").length <= 2 && !/closed/.test(hoursText);
  const subheadline = `${place.landmark ? `A short walk from ${place.landmark}, in ${hood}` : `In ${hood}, ${place.city}`}${simpleHours ? ` — open ${hoursText.replace(/^Daily\b/, "daily")}` : ""}.`;
  const names = brand.offerings.slice(0, 3).map((o) => o.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] || "";
  const t = biz.osmTags || {};
  const extras = [
    t["outdoor_seating"] === "yes" ? "outdoor seating" : "",
    t["takeaway"] === "yes" || t["takeaway"] === "only" ? "takeaway" : "",
    t["wheelchair"] === "yes" ? "step-free access" : "",
  ].filter(Boolean);
  return {
    headline: cap(headline).slice(0, 70),
    subheadline,
    about: brand.story,
    highlights: [
      {
        title: brand.offeringsConfirmed ? "From their own menu" : "What to expect",
        text: list
          ? `${list}${brand.offeringsConfirmed ? ", named on their own site." : " — the owner confirms the real menu."}`
          : `${cap(label)} on ${street || hood}.`,
      },
      { title: street ? `On ${street}` : `In ${hood}`, text: `${biz.address || hood}, ${place.city}${near}.` },
      hoursKnown
        ? { title: "Open hours", text: `${hoursText}${extras.length ? `, with ${extras.join(" and ")}` : ""}.` }
        : extras.length
          ? { title: "Good to know", text: `${cap(extras.join(" and "))}, per OpenStreetMap.` }
          : { title: "Hours", text: "Being confirmed with the owner — this page updates when they do." },
    ],
    offeringsTitle: defaultOfferingsTitle(biz),
    offerings: brand.offerings,
    ctaLabel: defaultCta(biz),
    seo: {
      title: `${biz.name} — ${label} in ${hood}`.slice(0, 60),
      description: `${biz.name}: ${label}${biz.address ? ` at ${biz.address}` : ""}, ${place.phrase}.`.slice(0, 155),
    },
  };
}

export async function composeSite(
  env: Env,
  biz: Business,
  brand: Brand,
  prev: SiteSpec | null,
  feedback: string[] = [],
): Promise<{ spec: SiteSpec; costCents: number; provider: string }> {
  const version = (prev?.version || 0) + 1;
  const theme = prev?.theme && !feedback.some((f) => /\btheme\b/i.test(f)) ? prev.theme : pickTheme(brand, biz);
  const place = placeFor(biz, env);
  const label = categoryLabel(biz);
  const hoursText = humanizeHours(biz.openingHours);
  const ev = getSiteEvidence(biz.id);
  const street = streetOf(biz);
  const isRevision = !!prev && feedback.length > 0;

  const t = biz.osmTags || {};
  const practical: string[] = [];
  if (t["outdoor_seating"] === "yes") practical.push("outdoor seating");
  if (t["indoor_seating"] === "yes") practical.push("indoor seating");
  if (t["takeaway"] === "yes" || t["takeaway"] === "only") practical.push(t["takeaway"] === "only" ? "takeaway only" : "takeaway");
  if (t["delivery"] === "yes") practical.push("delivery (per OSM)");
  if (t["reservation"] && t["reservation"] !== "no") practical.push(`reservations: ${t["reservation"]}`);
  if (t["diet:vegan"] === "yes" || t["diet:vegan"] === "only") practical.push("vegan options");
  if (t["diet:vegetarian"] === "yes" || t["diet:vegetarian"] === "only") practical.push("vegetarian options");
  if (t["wheelchair"] === "yes") practical.push("wheelchair accessible");
  if (t["internet_access"] === "wlan" || t["internet_access"] === "yes") practical.push("wifi");

  const system = `You are Builder, the senior copywriter-designer at Cold Open. You write one-page websites for real small businesses that read like a sharp local magazine wrote them: specific, warm, confident, in the business's own voice.
Every line must be true to the facts provided. When you don't know something, write around it — never invent history, owners, awards, reviews, prices, delivery areas, reservations or dishes.

HOW GOOD COPY READS (fictional hardware store, for tone only — never reuse its words):
  weak:   headline "Quality hardware for everyone" / subheadline "Indoor shopping available."
  strong: headline "Keys cut while you wait on Valencia" / subheadline "A narrow, well-stocked hardware store where the person at the counter knows which hinge you need."
  weak highlight:   { "title": "Location", "text": "Near downtown" }
  strong highlight: { "title": "Two doors from 20th", "text": "Find the green awning on Valencia — parking is easier on the side streets after 10am." }
Rules of thumb: full sentences, concrete nouns (dishes, materials, streets, times), one idea per line, no filler adjectives, no exclamation marks, no rhetorical questions, American English.`;

  const brandBlock = `BRAND KIT
- tagline: ${brand.tagline}
- voice: ${brand.voice}
- vibe: ${brand.vibe}
- keywords: ${brand.keywords.join(", ")}
- story (factual): ${brand.story}
- offerings (${brand.offeringsConfirmed ? "CONFIRMED from their own site — use these names exactly" : "NOT confirmed — category-typical placeholders; describe generally, no prices"}):
${brand.offerings.map((o) => `  • ${o.name}${o.price ? ` (${o.price})` : ""} — ${o.description}`).join("\n")}`;

  const revisionBlock = isRevision
    ? `

PREVIOUS DRAFT v${prev!.version} (the Critic did not pass it):
${JSON.stringify({ headline: prev!.headline, subheadline: prev!.subheadline, about: prev!.about, highlights: prev!.highlights, offeringsTitle: prev!.offeringsTitle, offerings: prev!.offerings, ctaLabel: prev!.ctaLabel }, null, 1)}

CRITIC NOTES — you are writing v${version}. Fix EVERY note so the change is visible; rewrite whole lines rather than patching words, and keep what already worked. A note's suggested wording is a hint: never copy a suggestion that adds a fact not found in BUSINESS FACTS or the website excerpt, and never use a banned phrase even if a note suggests it.
${feedback.slice(0, 10).map((n, i) => `${i + 1}. ${n}`).join("\n")}`
    : "";

  const prompt = `BUSINESS FACTS
- name: ${biz.name}
- what: ${label}${biz.osmTags?.cuisine ? ` (cuisine: ${biz.osmTags.cuisine})` : ""}
- address: ${biz.address ?? "(not listed)"}${street ? ` — street: ${street}` : ""}
- neighborhood: ${place.phrase}
- hours (from OpenStreetMap): ${hoursText}
- practical details (from OpenStreetMap): ${practical.join(", ") || "(none listed)"}
- phone listed: ${biz.phone ? "yes" : "no"}; website: ${biz.website ?? "none"}

${brandBlock}
${ev?.text ? `\nTHEIR OWN WEBSITE SAYS (excerpt — mine it for real, specific details; do not copy its clichés):\n"""${ev.text.slice(0, 1600)}"""` : "\n(No website text available: stay with what the facts support — the category, the street, the neighborhood, the hours.)"}

DESIGN: theme "${theme}", fonts ${brand.fonts.heading} / ${brand.fonts.body}, palette primary ${brand.palette.primary} on ${brand.palette.background}.${revisionBlock}

Write the site as JSON:
{
  "headline": "5-8 words: what it is plus something only true here (their street, a real item, a real detail)",
  "subheadline": "one full sentence, 12-22 words, adds a concrete detail the headline didn't",
  "about": "2-3 full sentences, 35-60 words, factual, in their voice",
  "highlights": [
    { "title": "2-4 words", "text": "one full sentence, 10-20 words" },
    { "title": "2-4 words", "text": "one full sentence, 10-20 words" },
    { "title": "2-4 words", "text": "one full sentence, 10-20 words" }
  ],
  "offeringsTitle": "2-4 plain words (e.g. 'From the kitchen', 'On the counter')",
  "offerings": [{ "name": "...", "description": "6-14 words"${brand.offeringsConfirmed ? ', "price": "exact price from the kit, or omit"' : ""} }],
  "ctaLabel": "2-4 words; the button scrolls to the address, hours and directions, so it is a visit/find-us action (e.g. 'Come by for coffee', 'Find us on King St')",
  "seo": { "title": "max 60 characters", "description": "120-150 characters" }
}

RULES
- Exactly 3 highlights, each a different kind of reason: (1) the food/product, (2) the place — street, neighborhood${place.landmark ? `, near ${place.landmark}` : ""}, (3) something practical and verifiable — the hours if known, the exact address and how to find it, or the phone number. Ground each in the facts above.
- offerings: 3-6 items. ${brand.offeringsConfirmed ? "Use the confirmed names exactly; keep prices only if given in the kit." : "We do NOT know their menu: no prices, and only generic category items (e.g. 'Tacos', 'Espresso drinks', 'Lunch plates'). Never name a specific dish or call anything 'signature', 'house-made' or 'handmade' — not in offerings, headline, highlights or about."}
- ${hoursText.includes("owner to confirm") ? "Hours are unknown: don't write about hours, calling ahead, walk-ins or take-out; make the third highlight about something else that is true (what they are, the block, the neighborhood)." : `Hours are known (${hoursText}); you may use them.`}
- Never mention delivery, takeaway/take-out/to-go, dine-in, seating (indoor or outdoor), patio, wifi, walk-ins, reservations, online ordering, catering, awards, reviews, ratings or years unless they appear in the facts or website excerpt. Service modes are the most common false claim; leave them out.
- The vibe and voice are design direction, not facts: don't describe their décor, interior, atmosphere, staff or sourcing ("fresh", "local", "organic") unless the website excerpt says so.
- Mention ${street ? `"${street}"` : "the neighborhood"} at least once in the headline, subheadline or about.
- Banned words/phrases: elevate, unleash, nestled, culinary, journey, tantalize, mouthwatering, look no further, in the heart of, whether you're, embark, delve, symphony, testament, haven, seamless, unparalleled, world-class, best-kept secret, hidden gem, indulge, delectable, exquisite, curated, vibrant, passion, unforgettable, boasts, gourmet, tastebuds, cozy atmosphere, something for everyone, best.`;

  let draft: LlmSite;
  let costCents = 0;
  let provider = "heuristic";
  try {
    const res = await llmJSON<LlmSite>(env, {
      system,
      prompt,
      maxTokens: 1800,
      temperature: isRevision ? 0.5 : 0.75,
      effort: isRevision ? "medium" : "low",
      // Fast first draft; the deliberate reasoning model takes the revisions.
      prefer: isRevision ? "smart" : "fast",
    });
    draft = res.data || {};
    costCents = res.costCents;
    provider = res.provider;
  } catch (e) {
    console.warn(`[builder] LLM failed for ${biz.id}: ${e instanceof Error ? e.message : e}`);
    draft = deterministicDraft(env, biz, brand, hoursText);
    if (isRevision) draft = applyClaimFixes(draft, feedback);
  }
  if (isRevision) {
    // Revisions must not reintroduce claims we can't back up, under any wording.
    const txt = [
      draft.subheadline,
      draft.about,
      ...(draft.highlights || []).map((h) => `${h?.title ?? ""} ${h?.text ?? ""}`),
      ...(draft.offerings || []).map((o) => `${o?.name ?? ""} ${o?.description ?? ""}`),
    ]
      .filter(Boolean)
      .join("\n");
    const extra = unsupportedClaims(biz, brand, txt).map((c) => `Unsupported claim "${c}"`);
    if (extra.length) draft = applyClaimFixes(draft, [...feedback, ...extra]);
  }
  const fb = deterministicDraft(env, biz, brand, hoursText);

  // ---- normalize -----------------------------------------------------------------------
  const clean = (v: string, allowDrop = true) => (isRevision ? scrubSlop(v, allowDrop) : v);

  // A headline can't lose a sentence, and cutting words out of 6 leaves a broken line — so on a
  // revision a headline that still carries slop is replaced by the factual template headline.
  const rawHeadline = s(draft.headline, 80) || (fb.headline as string);
  const headline = isRevision && slopHits(rawHeadline).length ? (fb.headline as string) : rawHeadline;
  const subheadline = clean(s(draft.subheadline, 200) || (fb.subheadline as string));
  const about = clean(s(draft.about, 520) || (fb.about as string));

  const highlights: SiteSpec["highlights"] = [];
  for (const h of Array.isArray(draft.highlights) ? draft.highlights : []) {
    const title = clean(s(h?.title, 48), false);
    const text = clean(s(h?.text, 180));
    if (title && text && highlights.length < 3 && !highlights.some((x) => x.title.toLowerCase() === title.toLowerCase())) highlights.push({ title, text });
  }
  for (const h of fb.highlights || []) {
    if (highlights.length >= 3) break;
    const title = s(h.title, 48);
    const text = s(h.text, 180);
    if (title && text && !highlights.some((x) => x.title.toLowerCase() === title.toLowerCase())) highlights.push({ title, text });
  }
  while (highlights.length < 3) highlights.push({ title: ["Visit", "Hours", "Say hello"][highlights.length], text: `${biz.name}, ${place.phrase}.` });

  // Offerings: confirmed items keep their real names and prices; otherwise no prices, ever.
  let offerings: SiteSpec["offerings"] = [];
  const llmOffers = (Array.isArray(draft.offerings) ? draft.offerings : [])
    .map((o) => ({ name: s(o?.name, 60), description: clean(s(o?.description, 140)) }))
    .filter((o) => o.name);
  if (brand.offeringsConfirmed) {
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    offerings = brand.offerings.slice(0, 6).map((o) => {
      const match = llmOffers.find((l) => norm(l.name) === norm(o.name) || norm(l.name).includes(norm(o.name)) || norm(o.name).includes(norm(l.name)));
      const description = match?.description || o.description;
      return o.price ? { name: o.name, description, price: o.price } : { name: o.name, description };
    });
  } else {
    offerings = llmOffers.slice(0, 6).map((o) => ({ name: o.name, description: o.description }));
    for (const o of brand.offerings) {
      if (offerings.length >= 3) break;
      if (!offerings.some((x) => x.name.toLowerCase() === o.name.toLowerCase())) offerings.push({ name: o.name, description: o.description });
    }
  }
  offerings = offerings.slice(0, 6);

  let ctaLabel = s(draft.ctaLabel, 26);
  if (!ctaLabel || CTA_BANNED.test(ctaLabel) || ctaLabel.split(/\s+/).length > 5) ctaLabel = defaultCta(biz);
  ctaLabel = ctaLabel.replace(/[.!]+$/, "");
  // A label clipped mid-address ("Find us at 1070") reads broken; the default is always whole.
  if (/(\d|,|\bat|\bon|\bin)$/i.test(ctaLabel.trim())) ctaLabel = defaultCta(biz);

  let offeringsTitle = s(draft.offeringsTitle, 40).replace(/[.:!]+$/, "");
  if (!offeringsTitle || /owner to confirm|preview/i.test(offeringsTitle)) offeringsTitle = defaultOfferingsTitle(biz);

  const seoTitle = s(draft.seo?.title, 60) || s(fb.seo?.title, 60);
  const seoRaw = typeof draft.seo?.description === "string" && draft.seo.description.trim() ? draft.seo.description : (fb.seo?.description as string);
  let seoDescription = clean(s(seoRaw, 155));
  if (seoRaw && seoRaw.replace(/\s+/g, " ").trim().length > seoDescription.length + 2 && !/[.!?]$/.test(seoDescription)) seoDescription = `${seoDescription}…`;

  const spec: SiteSpec = {
    version,
    theme,
    headline: headline.replace(/[.!]+$/, ""),
    subheadline,
    about,
    highlights: highlights.slice(0, 3),
    offeringsTitle,
    offerings,
    ctaLabel,
    hoursText,
    seo: { title: seoTitle, description: seoDescription },
  };
  return { spec, costCents, provider };
}
