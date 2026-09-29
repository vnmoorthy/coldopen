# The agents

Cold Open's "agents" are seven named roles, each a TypeScript module with one job, plus an optional outside reviewer. They are not autonomous processes: HQ (`src/hq.ts`) calls them in a fixed order, persists what they return and broadcasts it. Each one posts to the agent channel in Mission Control under its own name, color and two-letter monogram.

This page documents each agent from the code: what it reads, what it writes, which model it uses, what its prompt asks for, which rules are enforced in code regardless of the model, and where to change it.

| | Agent | Module | Model | Writes |
|:-:|---|---|---|---|
| Sc | [Scout](#scout) | `src/pipeline/scout.ts` | none | `Business` rows (`scouted`) |
| Ar | [Archivist](#archivist) | `src/pipeline/brand.ts` | `llmJSON` | `biz.brand` |
| Bu | [Builder](#builder) | `src/pipeline/builder.ts` | `llmJSON` | `biz.site` (`SiteSpec` vN) |
| Cr | [Critic](#critic) | `src/pipeline/critic.ts` | `llmJSON` + deterministic checks | `biz.scores[]` |
| Di | [Director](#director) | `src/pipeline/director.ts` | image models | `biz.heroImage`, `biz.video` |
| Cl | [Closer](#closer) | `src/pipeline/closer.ts` | `llmJSON` (two lines only) | `biz.pitch`, `biz.paymentUrl` |
| CF | [CFO](#cfo) | inside `src/hq.ts` | none | money and spend events |
| | [Brainbase second opinion](#brainbase-second-opinion) | `src/integrations/brainbase.ts` | Brainbase managed agent | Critic events only |

A `System` pseudo-agent also posts lifecycle messages (HQ online, build started, block done, restarts, removals).

**About `llmJSON`.** Every agent that uses a language model calls `llmJSON()` in `src/llm.ts`. It tries Claude (`sk-ant-` key), then OpenAI (`gpt-5-mini` by default), then Workers AI Llama 3.3 70B and gpt-oss-120b, and returns parsed JSON plus the provider, model, estimated cost and latency. The live demo on Sep 28, 2026 ran on OpenAI `gpt-5-mini`. Details are in [ARCHITECTURE.md](ARCHITECTURE.md#7-the-llm-chain-and-cost-accounting).

**About guardrails.** The prompts ask models to behave. The guardrails listed below are the parts that do not depend on the model behaving: they are plain code that runs on every output.

---

## Scout

Finds real, independent businesses around HQ on OpenStreetMap. No model and no API key.

### Inputs

- `HQ_LAT`, `HQ_LON` (default 37.7786, -122.3893: 101 Townsend St, San Francisco)
- `POST /api/scout {radius, limit}`: radius 100 to 2000 m (default 450), limit 1 to 60 (default 24)
- `POST /api/businesses {name, website?, category?, address?}` for a single business by name (Mission Control's "Add" and the Live challenge)

### Outputs

`Business` rows with `status: "scouted"`, carrying name, category, coordinates, address, website, phone, email, `opening_hours` and up to 40 OSM tags (translations and bookkeeping tags such as `name:*`, `source`, `check_date`, `wikidata` are dropped).

### How it works

**Block sweep** (`scoutNearby`). One Overpass QL query:

```
nwr(around:R,LAT,LON)["name"]["amenity"~"^(cafe|restaurant|bar|fast_food|pub|ice_cream|bakery)$"];
nwr(around:R,LAT,LON)["name"]["shop"];
nwr(around:R,LAT,LON)["name"]["craft"];
out center tags;
```

It is sent to three public mirrors (`maps.mail.ru`, `overpass-api.de`, `overpass.kumi.systems`) with hedging: the next mirror starts after 4.5 s of silence or immediately after a failure, each has a 20 s timeout, and the first valid JSON wins. If all fail quickly, it waits 1.5 s and tries once more. If that fails too, it reads the bundled snapshot `src/pipeline/osm-snapshot.json` (87 elements within 600 m of 101 Townsend St, captured Sep 28, 2026, ODbL) filtered to the radius.

Results are then filtered and ranked: places with a website first, then by distance. HQ drops any OSM id already on the board (including removed businesses) and inserts up to `limit`.

**Name lookup** (`findByName`). Nominatim first (bounded to a 1.5 km box around HQ, 8 s), then an accent-insensitive Overpass regex over `amenity`, `shop`, `craft`, `office`, `tourism` and `leisure`. Candidates within 1.6 km are ranked exact name, then prefix, then substring, then with-website, then distance. HQ caps the lookup at 15 s (8 s when a website was supplied, since the lookup then only adds a map pin and hours).

### Guardrails in code

- **Independents only.** Anything tagged `brand`, `brand:wikidata`, `brand:wikipedia` or `operator:wikidata` is skipped, plus 127 well-known chain names that often lack those tags (`KNOWN_CHAINS`). Name lookups allow chains, because a person asked for that business by name.
- **Real, open places.** Skips `shop=vacant|no|none|disused|yes;vacant|kiosk`, any `disused:shop` / `disused:amenity`, and `opening_hours=closed`.
- **Usable names.** 2 to 80 characters, at least one letter, and not a generic word such as "cafe", "restaurant", "parking" or "atm".
- **No duplicates.** Deduped by OSM id and by normalized name within a sweep; HQ also reuses an existing business with the same slugified name (ignoring a leading "The") or OSM id instead of adding it twice.
- **Removed means removed.** A business removed by its owner keeps its row, so the Scout never adds it again, and adding it by name returns `409`.
- **Polite to the mirrors.** One sweep at a time (`409` otherwise), a 70 s cap per sweep, and the snapshot instead of a retry loop when every mirror is down. Requests identify themselves with the User-Agent `ColdOpen/1.0 (hackathon demo)`.

### Events

`Scout info` at the start of a sweep; `Scout success` with the count, a category breakdown, how many list a website and the closest one; `Scout warn` when Overpass fails. With Slack configured, one summary per sweep.

### Extend it

- **Another city:** set `HQ_LAT` and `HQ_LON` in `wrangler.jsonc`. Some copy still names 101 Townsend St and SoMa (see [FAQ.md](FAQ.md#can-i-run-it-for-a-different-city)).
- **Different business types:** edit the Overpass query in `scoutNearby()` and the category regexes in `brand.ts` (`isFoodish`, `CATEGORY_LABELS`) and `director.ts` (`CATEGORY_SCENES`).
- **More chain names:** add to `KNOWN_CHAINS`. Matching is on normalized names; multi-word chains also match mid-name.
- **Another data source:** return `ScoutedPlace[]` from a new function and call it from `scoutBlock()` in `hq.ts`. Keep the chain filter and the dedupe.

---

## Archivist

Reads the business's own website and turns it into a `Brand`: palette, fonts, voice, vibe, keywords, offerings and a short factual story, with a list of exactly what it read.

### Inputs

- The business's homepage (if `biz.website` is set): fetched once with an 8 s timeout, at most 700,000 bytes, HTML only. If the page has fewer than three non-neutral colors or loads no Google Fonts, the first same-site stylesheet is fetched too (4 s, 200,000 bytes), skipping known framework CSS such as Bootstrap and Font Awesome.
- OSM facts: category, cuisine, address, hours, and practical tags such as `outdoor_seating`, `takeaway`, `delivery`, `diet:*`, `wheelchair`.
- Optional: a Taste Labs brand extraction for the same URL (with `TASTE_API_KEY`), run in parallel and capped at 22 s.

What it parses from the HTML (`parseSite`): `<title>`, meta description, `og:title`, `og:description`, `og:image`, `og:site_name`, `theme-color`, the 16 most frequent CSS colors (framework defaults such as WordPress and Bootstrap presets are ignored, translucent colors skipped, inline styles weighted double, `theme-color` weighted heavily), Google Fonts families, other `font-family` names, up to 14 `h1` to `h3` headings, up to 3,000 characters of visible text and every `$` price it sees.

### Outputs

`BrandResult { brand, costCents, provider, signals }`. `brand.sourceSignals` lists the evidence, for example `website title "…"`, `theme-color #…`, `CSS colors …`, `Google Fonts: …`, `12 headings`, `OSM cuisine=…`, `website … could not be read`. The signals are printed in the agent channel and in the "How this preview was made" panel on every preview.

The evidence itself is cached in memory per business so the Builder, Critic and Director can check claims against the page.

### Model and prompt

`llmJSON`, max 1,600 tokens, temperature 0.4, effort low. The system prompt says:

> You extract a small business's REAL brand from evidence. You never invent facts

and lists what that means: no founding years, owners' names, awards, reviews, ratings, "family-owned", "since", signature dishes or prices unless the evidence states them. The user prompt contains the OSM facts, the website evidence block (or "exists but could not be read right now. Do NOT pretend you read it."), the Taste Labs kit when present, and the JSON shape to return.

Key rules in the prompt:

- **Palette.** If the site has brand-worthy colors: "Primary MUST be taken from the site's own CSS colors or theme-color". Otherwise the model must pick one of 14 curated palettes (`terracotta`, `saffron`, `espresso`, `washi`, `harbor`, `ballpark`, `nightcap`, and others) and name it.
- **Fonts.** Only from a 72-family Google Fonts allowlist, or the Google Fonts the site already loads (preferred).
- **Offerings.** Real names from the site with `offeringsFromSite: true`, or honest category-typical items with no prices.
- **Story.** Only supported facts; if the evidence is thin, a plain what-and-where sentence.
- A banned-words list (elevate, nestled, hidden gem, curated, vibrant, and others).

### Guardrails in code

All of these run after the model answers, and all of them run when no model answered at all.

- **Palette honesty.** If the site had brand-worthy colors and the model's primary is not within a small RGB distance of one of them, the primary is replaced by the site's `theme-color` or its most frequent brand color. The accent gets the same check. A Taste Labs palette, when present, wins.
- **Legibility.** Text on background at least 4.5:1, text on the secondary surface at least 4.5:1, primary and accent on background at least 3:1. Colors are nudged in lightness until they pass.
- **Real fonts.** Any font name is mapped to an allowlisted family or one the site loads, using style rules (a Didot-like name becomes Playfair Display, a Futura-like name becomes Outfit, and so on). A display face is never used as the body font.
- **Confirmed offerings are verified.** `offeringsConfirmed` is true only if the page had readable text, the model said the items came from the site, and at least three item names actually appear in the page text. Food businesses drop merchandise (tees, mugs, gift cards). A price is kept only if the same amount was seen on the page.
- **A grounded story.** Each sentence of the story is kept only if every "risky" word in it (`since`, `established`, `founded`, `family-owned`, `award`, `famous`, `legendary`, `decades`, any year, and more) also appears in the evidence. Sentences that talk about the website itself are dropped. If less than 30 characters survive, or the site was not readable, the story is a fixed factual sentence such as "{Name} is a bakery at {address} in SoMa, San Francisco, a short walk from Oracle Park."
- **Fallback brand.** If every model fails, the brand comes from a category preset (coffee, restaurant, bar, sweets, shop), with cuisine-typical offerings for food businesses, and the signals say "brand model unavailable — category defaults used".

### Events

`Archivist info` (what it is about to read), `Archivist success` with colors, fonts, voice, up to four pieces of evidence and whether offerings were read off the site.

### Extend it

- **Read more evidence:** add fields to `SiteEvidence` and parse them in `parseSite()`. Add a signal line in `extractBrand()` so the provenance panel shows it.
- **Add a curated palette:** add an entry to `PALETTES` with a `hint`; `finalizePalette()` still enforces contrast.
- **Add a font:** add it to `FONT_ALLOWLIST` and give it an axis spec in `FONT_SPECS` in `src/site/render.ts` so the renderer requests the right weights.
- **Respect `robots.txt`:** not implemented today. The natural place is a check in `readWebsite()` that returns `null` when disallowed, which already makes the Archivist fall back to OSM facts. [docs/ETHICS.md](ETHICS.md) lists it as a project rule.

---

## Builder

Writes the site: headline, subheadline, about, three highlights, offerings, a call to action and SEO text, in one of three visual themes.

### Inputs

`composeSite(env, biz, brand, prev, feedback)`: the business, the brand kit, the previous draft (on revisions), the Critic's notes, the cached website text (up to 1,600 characters go into the prompt), the OSM hours and practical tags.

### Outputs

`SiteSpec { version, theme, headline, subheadline, about, highlights[3], offeringsTitle, offerings[], ctaLabel, hoursText, seo }`. HQ saves each version as `biz.site` as soon as it is drafted.

### Model and prompt

`llmJSON`, max 1,800 tokens. First draft: temperature 0.75, effort low, `prefer: "fast"`. Revisions: temperature 0.5, effort medium, `prefer: "smart"` (the reasoning model first on Workers AI).

The system prompt casts the model as a senior copywriter-designer and states the core rule:

> Every line must be true to the facts provided.

It includes a weak-versus-strong example for a fictional hardware store ("never reuse its words") and style rules: full sentences, concrete nouns, no filler adjectives, no exclamation marks, no rhetorical questions, American English.

The user prompt holds the business facts, the brand kit (offerings marked CONFIRMED or NOT confirmed), the website excerpt, the design direction and the JSON shape with word counts (headline 5 to 8 words, subheadline 12 to 22, about 35 to 60, highlights 10 to 20). Its rules include:

- Exactly three highlights: the product, the place, and something practical and verifiable.
- Unconfirmed menus: no prices, generic names only, and "Never name a specific dish or call anything 'signature', 'house-made' or 'handmade'".
- Unknown hours: do not write about hours, calling ahead, walk-ins or take-out.
- "Never mention delivery, takeaway/take-out/to-go, dine-in, seating ... unless they appear in the facts or website excerpt. Service modes are the most common false claim".
- "The vibe and voice are design direction, not facts".
- Mention the street at least once.
- The CTA button scrolls to the address and hours, so it must be a visit or find-us action.
- A banned-words list.

On a revision, the prompt adds the previous draft and the numbered Critic notes with the instruction "Fix EVERY note so the change is visible", and warns never to copy a suggestion that adds a fact not in the evidence or uses a banned phrase.

### Guardrails in code

- **Theme.** `pickTheme()` counts vibe/voice/keyword words that signal `bold`, `warm` or `editorial`, with the category as tiebreaker (bars and game stores lean bold, cafés and bakeries warm, everything else editorial). A revision keeps the theme unless a note mentions "theme".
- **Hours are never written by the model.** `hoursText` is `humanizeHours(biz.openingHours)`: OSM syntax such as `Mo-Fr 07:00-16:00; Sa 08:00-13:00` becomes `Mon–Fri 7am–4pm · Sat 8am–1pm`, and anything unknown becomes `Hours — owner to confirm`.
- **CTA.** A label containing order, book, reserve, deliver, buy, shop now, sign up, subscribe, call, download, learn more, click or submit, or longer than five words, or ending in a number or a dangling "at/on/in", is replaced by a category default ("Come by for coffee", "Meet us at the bar", "Visit the shop").
- **Offerings.** Confirmed offerings keep their exact names and only the prices the Archivist verified. Unconfirmed offerings never carry a price. At least three are kept.
- **Exactly three highlights**, deduplicated by title and topped up from a factual template if the model gave fewer.
- **Revisions cannot reintroduce problems.** On a revision, banned phrases are scrubbed (patched in place or the sentence dropped), a headline that still contains one is replaced with a factual template headline, and any unsupported claim the Critic's fact check would flag (see [TASTE-GATE.md](TASTE-GATE.md#the-unsupported-claims-fact-check)) is cut from the draft.
- **Lengths.** Each field is clipped at a sentence or word boundary (headline 80 characters, SEO title 60, SEO description 155).
- **Fallback.** If every model fails, `deterministicDraft()` writes a plain factual page from the category, street, neighborhood, hours and offerings, for example "A bakery on 2nd Street".

### Events

`Builder info` ("Composing v1…" or "Revising into v2 against 3 critic notes") and `Builder success` with the theme, headline and CTA.

### Extend it

- **A new field on the page:** add it to `SiteSpec` in `src/types.ts`, ask for it in the prompt, normalize it in `composeSite()`, render it in `src/site/render.ts`, and update `SPEC.md` and `docs/API.md` in the same pull request.
- **A new theme:** add it to `SiteTheme`, teach `pickTheme()` when to choose it, and add its CSS and body function in `render.ts`. The preview banner must stay visible in every theme.
- **Different copy rules:** edit the RULES block of the prompt, and mirror any hard rule as code (a regex or a check in `critic.ts`) so it holds even when a model ignores it.

---

## Critic

The taste gate. Scores each draft from 0 to 100; anything under 85 goes back to the Builder with notes, for up to three versions. The full mechanics, the rubric, the banned-phrase list and the fact check are in **[TASTE-GATE.md](TASTE-GATE.md)**. This is the summary.

### Inputs

`critique(env, biz, brand, spec)`: the draft, the brand kit, the business facts, the evidence signals, the prices printed on the site and up to 1,500 characters of the site's own text.

### Outputs

`ScoreVersion { version, score, notes[], slopHits[], provider, at }`, appended to `biz.scores`.

### Model and prompt

`llmJSON`, max 1,200 tokens, temperature 0.1, effort low, `prefer: "smart"`. The model does not produce a score. It answers a 14-item pass/fail checklist worth 30 (brand fidelity), 25 (specificity), 20 (clarity), 15 (voice) and 10 (CTA) points, and for each failed check writes a fix that quotes the offending text. The system prompt:

> You are tough but fair ... You never inflate scores.

The user prompt adds "when in doubt, fail it" and "Typical first drafts fail 3-5 of these checks."

### Guardrails in code

- The score is computed in code from the checklist answers, then reduced by 6 points per banned phrase found (56 phrases, matched by regex) and by fixed structural deductions (headline too long, prices on an unconfirmed menu, no location, unsupported claims, and more).
- Notes that would teach the Builder a banned phrase or a superlative are dropped.
- If fewer than 9 of the 14 checks come back answered, or every model fails, the score falls back to a labeled heuristic.

### Events

`Critic success` or `warn` per version with the score, the change from the previous version, the top notes and any banned phrases; `Critic info` when an earlier version is shipped because it scored higher; `Critic warn` when the best version is still under the bar.

### Extend it

See [TASTE-GATE.md](TASTE-GATE.md#extending-the-critic).

---

## Director

Directs the hero image and, optionally, a short video.

### Inputs

`makeHero(env, biz, brand, spec)`: category and cuisine, brand vibe, palette, the site's theme, and the `og:image` the Archivist found.

### Outputs

`{ heroImage: "/img/<encoded KV key>", costCents, model, prompt }`. The bytes live in KV under `img:{bizId}:{timestamp}` with metadata `{contentType, model, bizId}`. Video state lives in `biz.video`.

### Model and prompt

No language model. The image prompt is built by `heroPrompt()` from fixed parts:

1. A scene: a cuisine scene (19 mappings, for example Argentinian "golden baked empanadas and a cortado on a small marble café table") or a category scene (17 mappings, for example books "stacked books and a brass reading lamp in a quiet independent bookshop"), else the first offering "displayed inside a small independent shop".
2. `Mood:` the brand vibe.
3. Lighting by theme: bold "high contrast, punchy color, dramatic side light"; warm "soft golden morning light"; editorial "clean natural daylight".
4. Up to three palette colors translated to words ("terracotta", "deep teal", "soft cream").
5. Camera and composition ("Shot on 35mm ... wide 16:9 composition with room for a headline on one side").
6. "No text, no letters, no words, no logos, no signage, no watermarks, no people's faces close-up."

The prompt then goes down the image chain: Workers AI FLUX.1 schnell, FLUX.2 klein, OpenAI gpt-image-1, dall-e-3, then the business's own `og:image` re-hosted. See [ARCHITECTURE.md](ARCHITECTURE.md#8-the-image-chain).

### Video (Higgsfield)

- **On demand:** `POST /api/businesses/:id/video` (the per-card button) sends the hero frame to Higgsfield image-to-video. **Automatic:** only when the Worker var `AUTO_VIDEO` is `"1"`, and never for block runs, because renders cost Higgsfield credits.
- Models tried in order when the account lacks one (404, 423, 503): Kling 2.5 Turbo (5 s), MiniMax Hailuo 2.3 (6 s), Kling 3.0 Turbo (5 s). An optional `HIGGSFIELD_MODEL` var puts a specific endpoint first.
- The motion prompt (`suggestVideoPrompt`) uses only the category, vibe and keywords, and ends "No text, no logos, no captions."
- KV hero images are uploaded straight to Higgsfield storage, so the render does not depend on Higgsfield reaching the Worker.
- A timed-out submit is never retried automatically (it could bill twice). Polling runs every 15 s through a Durable Object schedule and gives up after 10 minutes.
- `POST /api/businesses/:id/video-url {url}` attaches any externally rendered video instead.

### Guardrails in code

- Only JPEG, PNG or WebP bytes are accepted, checked by magic number.
- A re-hosted `og:image` must be between 8 KB (smaller is usually a logo or a tracking pixel) and 8 MB.
- The preview captions the image "Illustrative image · AI-generated for this concept" (or "Concept film · AI-generated" for video), and the footer says imagery is AI-generated and illustrative.
- A failed Director stage never fails the build: the site keeps its previous frame or shows a typographic hero.

### Events

`Director info` (directing, with the vibe), `Director success` with the model and time, `Director warn` when every source failed. Video: start, rendering (job id, model), ready or failed.

### Extend it

- **Another image source:** add an `attempt("name", estimatedCents, () => fetchBytes())` line in `makeHero()` at the right position in the chain. Return raw bytes; the function handles KV and bookkeeping.
- **Better scenes:** add entries to `CUISINE_SCENES` or `CATEGORY_SCENES`. Keep them free of people, text and logos.
- **Another video provider:** follow `higgsfield.ts`: a `start` that returns a job id, a `poll` that returns `rendering | ready | error`, errors that say whether a retry can help, and a schedule callback in `hq.ts`.

---

## Closer

Wires the checkout link and writes a short, honest pitch email. It never sends anything.

### Inputs

The business, brand, shipped `SiteSpec`, the preview URL and the claim URL.

### Outputs

- `biz.paymentUrl`: a dedicated $49 Stripe Payment Link for this business when `STRIPE_SECRET_KEY` is a test key, else the shared `PAYMENT_LINK` with `client_reference_id=<id>`. See [ARCHITECTURE.md](ARCHITECTURE.md#9-payment-attribution).
- `biz.pitch = { subject, body }`.

### Model and prompt

`llmJSON`, max 300 tokens, temperature 0.6, effort low. The model writes only two things: a subject line (max 60 characters, must contain the business name) and **one** sentence of 14 to 26 words describing what the preview shows. The system prompt:

> Never flatter, never claim to be a customer, never promise results, never invent facts.

Everything else in the email is fixed text in `closer.ts`: who we are and how far away ("two blocks away", "a few blocks away", computed from the coordinates), that we built the site before asking, a note that anything marked "owner to confirm" is a placeholder (only when the menu is unconfirmed), the preview link, the $49 offer, and the exit line "No pressure either way. Reply "remove" and we delete it the same day."

### Guardrails in code

- The model's lines are rejected if they contain an exclamation mark or any of: love, favorite, best, amazing, incredible, guarantee, limited time, act now, hurry, only today, "customers are", reviews, rated, award, "increase sales", "more customers", boost; or any banned phrase from the Critic's list; or (for the subject) if the business name is missing; or (for the detail) if it runs over 30 words. Rejected lines are replaced by fixed fallbacks such as "We built {name} a website (before asking)".
- The body is capped at 140 words: first the placeholder note is dropped, then the model's sentence.
- Payment links are only created with a test-mode key; with a live key the shared link is used.
- Nothing is sent. Mission Control offers Copy and a `mailto:` link; **Mark contacted** and **Mark replied** are manual, and HQ's event says "Cold Open never auto-emails."

Known limitation: the fixed offer text mentions "a short launch ad" whether or not a video integration is configured; a video can be attached to any preview by URL.

### Events

`Closer info` (wiring checkout), `Closer success` with the subject and whether the link is dedicated; `Closer info` when someone opens a preview or hits "Claim it"; `Closer money` when a claim is paid.

### Extend it

- **Change the email:** edit the fixed strings in `writePitch()`. Keep the price, the opt-out line and the word cap, and keep promises out of the model's hands.
- **Actually send email:** not implemented. It should be a separate, explicit action with suppression lists, an unsubscribe link and a postal address, per the outreach rules in [docs/ETHICS.md](ETHICS.md#rules-for-outreach). Never trigger it from the pipeline.
- **A different price:** `LAUNCH_PACK_CENTS` in `src/integrations/stripe.ts` drives per-business links, `/api/config` and the CFO; the shared Payment Link's price is set in Stripe, and the "$49" strings in `closer.ts`, `render.ts` and `hq.ts` need the same change.

---

## CFO

Keeps the books. No model: arithmetic over the numbers the other agents report.

### Inputs

`biz.costCents` (estimated model spend per business, see [ARCHITECTURE.md](ARCHITECTURE.md#cost-accounting)), `paidAt` and `amountCents`.

### Outputs

`stats.spendCents`, `stats.revenueCents` and `money` / `info` events:

- **After each build:** what it cost and the board's spend against revenue. With no revenue yet, it adds how many builds one $49 claim would cover at the current average cost per built site. With revenue, it gives revenue as a multiple of spend.
- **After a block run:** the block's spend and the spend per live site.
- **After a payment:** total revenue, number of claims and spend, with the multiple.
- **Warnings:** a verified payment with no business attached, or a session Stripe could not verify.

Spend under a cent is shown with two decimals and a ¢ sign rather than rounded to $0.00.

On the live demo (Sep 28, 2026), spend for the whole board stayed under $1 (about 4 to 6¢ per site) and revenue was $0, because checkout is in Stripe test mode.

### Extend it

- **Price a new model:** add it to `claudePrice()` or the OpenAI price line in `src/llm.ts`, or to the image cost constants in `director.ts`.
- **Count an integration's cost:** return `costCents` from the stage (or attach it to a thrown error); HQ adds it to the business. Taste Labs, Brainbase and Higgsfield are not counted today.

---

## Brainbase second opinion

An independent reviewer from outside the pipeline. When `BRAINBASE_API_KEY` is set, every completed build (final status ready, contacted, replied or paid) is sent to a [Brainbase Labs](https://brainbaselabs.com) managed agent that fetches the live preview itself and grades it cold.

### Inputs

The business name, the public preview URL (`{PUBLIC_URL}/s/{id}`) and a one-line brand summary labeled "context only; do not treat it as verified fact".

### Outputs

Two `Critic` events, nothing else. The review is **not** stored on the business and never changes `biz.scores` or the shipped site.

- `info`: "Asking a Brainbase Labs agent (harness claude_code) for an independent second opinion on …"
- `success` (score 85 or more) or `info`: "Brainbase second opinion (harness claude_code): {score} — {verdict}", with `data: { provider: "brainbase", threadId, traceUrl?, score, model, ms }`.
- `warn` if the review is unavailable, with the reason when known (for example "the Brainbase account is out of credits (HTTP 402)").

On the live demo, the second opinion on Underdogs Cantina scored it 76 and took about 146 s.

### Model and prompt

- `POST https://api.brainbaselabs.com/v2/threads` with `agent: { harness: "claude_code", model: "claude-haiku-4-5-20251001", instructions }`. If the API rejects that model spec with a 4xx other than 401/403, it retries once with the harness default model.
- The instructions tell the agent that it did not build the page and "owe[s] its makers nothing", to fetch the URL and inspect headline and copy, hierarchy, calls to action, fit, honesty (no invented reviews, ratings, awards or prices), mobile readiness and accessibility basics, not to ask questions or modify files, and to reply with one line of JSON: `{"verdict":"<exactly two sentences>","score":<integer 0-100>}`.
- HQ polls `GET /v2/threads/{id}` every 3 s while the status is `running` (or `queued`, `pending`, `starting`, `created`), then reads the transcript from `GET /v2/threads/{id}/messages?limit=50` even if polling ran out of time.

### Guardrails in code

- Runs in the background after the build finishes; it can never delay or fail a build.
- The whole review is bounded by a 290 s budget (`BUDGET_MS`); every request is aborted when it expires.
- `reviewSite()` never throws. Any failure returns `null`.
- The verdict parser takes the last JSON object with a `verdict`; if there is none, it keeps the reviewer's plain text, unscored, rather than inventing a score.
- A trace URL is shown only if the API returns one; it is never guessed.
- A board reset or a removal while the review runs discards the result.

### Extend it

- **A different harness or model:** change `BRAINBASE_HARNESS` / `BRAINBASE_MODEL` in `src/integrations/brainbase.ts`.
- **Store the review:** add a field to `Business` (for example `secondOpinion`) in `src/types.ts`, set it in `brainbaseSecondOpinion()` in `hq.ts`, and render it in the drawer. Update `SPEC.md` and `docs/API.md` with the type change.
- **Let it gate shipping:** not recommended. It takes minutes, costs credits per review, and is designed to be a second opinion, not a blocker.

---

## Adding a new agent

The checklist lives in [CONTRIBUTING.md](../CONTRIBUTING.md#adding-an-agent). In short: add the name to `AgentName`, write a pure module in `src/pipeline/` that returns data and `costCents`, call models only through `llmJSON()`, wire it into `runPipeline()` with its own timeout, `check()` after every await, emit events with `bizId`, and decide explicitly whether its failure is fatal to the build.
