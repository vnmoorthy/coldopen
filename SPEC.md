# COLD OPEN — build spec (single source of truth for all builders)

> "The agency that does the work before the sale."
> Agents scout real small businesses around Cloudflare HQ (101 Townsend St, SF), extract each brand,
> build a beautiful site for it, gate quality with a critic loop until score >= 85, direct a hero visual
> (and optional Higgsfield video), write an honest pitch, and attach a Stripe checkout. Mission Control
> shows it all live. Built at the Startup Speedrun Hackathon (Brainbase x Anthropic x Cloudflare x Stripe).

Deployed at: https://coldopen.vnarasingamoorthy.workers.dev  (Worker name `coldopen`)
Stripe TEST payment link (already created, $49 "Cold Open Launch Pack"):
  https://buy.stripe.com/test_cNieV5am70px0O47jK0Ny00
  (redirects after payment to https://coldopen.vnarasingamoorthy.workers.dev/claimed?session_id={CHECKOUT_SESSION_ID})
  Append `?client_reference_id=<businessId>` to attribute a payment to a business.

## Hard rules
- Every button in the UI must work against the real API. No dead buttons, no fake data, no fabricated numbers.
- NEVER fabricate reviews/testimonials/ratings/awards/prices for real businesses. Unknown menu items → describe
  category-typical offerings WITHOUT prices and label the section "Preview — owner to confirm".
- Every generated site shows a sticky banner: "Unofficial concept preview made for {name} by Cold Open — not the
  official site." with buttons "Claim it · $49" and "Remove this preview". Sites have `<meta name="robots" content="noindex,nofollow">`.
- Graceful degradation: the product must fully work with ONLY Workers AI + KV + DO (no external keys).
  Optional secrets upgrade features: ANTHROPIC_API_KEY (Claude as the brain), STRIPE_SECRET_KEY (verify payments,
  per-business payment links), STRIPE_WEBHOOK_SECRET, SLACK_WEBHOOK_URL, HIGGSFIELD_API_KEY (+HIGGSFIELD_API_SECRET), TASTE_API_KEY.
- TypeScript, Cloudflare Workers runtime (no Node-only APIs except via nodejs_compat). No extra npm deps beyond `agents`.
- Frontend = static files in `public/` (vanilla JS ES modules, no build step). CDN allowed: Leaflet (unpkg/cdnjs), Google Fonts.

## Files & owners
```
wrangler.jsonc            (lead)   bindings below
src/types.ts              (lead)   shared types — DO NOT change shapes without updating SPEC
src/index.ts              (backend) Worker router
src/hq.ts                 (backend) HQ Agent (Durable Object via Agents SDK) — state, events, pipeline orchestration, WS broadcast
src/llm.ts                (backend) llmJSON(): Claude if key else Workers AI
src/pipeline/scout.ts     (backend) OSM Overpass scouting
src/pipeline/brand.ts     (backend) brand extraction
src/pipeline/builder.ts   (backend) SiteSpec composition
src/pipeline/critic.ts    (backend) taste gate critic + deterministic slop penalty
src/pipeline/director.ts  (backend) hero image via Workers AI → KV; video via integrations/higgsfield
src/pipeline/closer.ts    (backend) pitch email
src/integrations/stripe.ts   (backend) webhook verify (WebCrypto HMAC), session verify, per-biz links when key present
src/integrations/slack.ts    (backend) incoming webhook notify
src/integrations/higgsfield.ts (integrations) startVideo()/pollVideo() — best effort per real API docs
src/integrations/taste.ts      (integrations) extractBrand()/scoreAgainstBrand() — best effort per real API docs
src/site/render.ts        (site)   renderSite(), renderClaimed(), renderRemoved(), renderNotFound()
public/index.html, public/app.js, public/styles.css  (frontend) Mission Control
```

## wrangler.jsonc bindings (lead writes it)
- `main: src/index.ts`, `compatibility_flags: ["nodejs_compat"]`
- `assets: { directory: "./public", binding: "ASSETS", run_worker_first: ["/api/*", "/s/*", "/agents/*", "/claimed", "/img/*"] }`
- Durable Object: binding `HQ`, class `HQ` (sqlite; migration tag v1 `new_sqlite_classes: ["HQ"]`)
- KV: binding `MEDIA` (id a59522fd4f5f424bb78980df7be74b44)
- AI: binding `AI`
- vars: `PUBLIC_URL`, `PAYMENT_LINK`, `CLAUDE_MODEL` = "claude-sonnet-5", `HQ_LAT` = "37.7786", `HQ_LON` = "-122.3893"

## Shared types (src/types.ts)
See file. Key: `Business`, `Brand`, `SiteSpec`, `ScoreVersion`, `AgentEvent`, `Stats`, `Snapshot`, `Env`.

## Agents (personas shown in the UI channel; each has color + emoji-free monogram)
Scout (finds businesses) · Archivist (brand extraction) · Builder (site composition) · Critic (taste gate) ·
Director (hero visual / video) · Closer (pitch + checkout) · CFO (spend vs revenue) · System

## Pipeline for one business (HQ.runPipeline(id))
1. status `extracting` → Archivist: `extractBrand(env, biz)` (fetch website HTML w/ 8s timeout; parse title, meta description,
   og:image, theme-color, hex colors frequency, headings, visible text ≤3000 chars; then llmJSON → Brand). No website → infer from name/category/OSM tags.
   If TASTE_API_KEY → also call taste.extractBrand(url) and merge (best-effort, never fatal).
2. status `building` → Builder: `composeSite(env, biz, brand, feedback[])` → SiteSpec (theme chosen by brand vibe).
3. status `critiquing` → Critic: `critique(env, biz, brand, spec)` → {score 0-100, notes[]}. Loop up to 3 versions: if score < 85,
   feed notes back into composeSite. Record every version in `biz.scores` (this is the visible self-improvement loop).
4. status `directing` → Director: `makeHero(env, biz, brand, spec)` → Workers AI `@cf/black-forest-labs/flux-1-schnell`
   (fallback `@cf/black-forest-labs/flux-2-klein-4b`), store bytes in KV key `img:{id}:{n}`, set `biz.heroImage = "/img/img:{id}:{n}"`.
   If HIGGSFIELD key → kick off video (non-blocking), status tracked in `biz.video`.
5. Closer: `writePitch(...)` → `biz.pitch` {subject, body}; `biz.paymentUrl` = PAYMENT_LINK + `?client_reference_id={id}` (or per-biz link if STRIPE_SECRET_KEY).
6. status `ready`; `biz.timings` filled (ms per stage + total); CFO event with estimated cost.
Each step emits AgentEvents (with bizId) and broadcasts the updated Business.
Errors: mark `error` with `biz.error`, emit error event, never crash the DO.

## HTTP API (all JSON; Worker forwards /api/* to the HQ agent instance "main")
- `GET  /api/state` → Snapshot
- `GET  /api/config` → { publicUrl, paymentLink, hq:{lat,lon,label}, integrations:{claude,workersAI,stripeApi,stripeWebhook,slack,higgsfield,taste} (booleans) }
- `POST /api/scout` {radius?=450, limit?=24} → { added: Business[], total }  (Overpass mirrors chain: maps.mail.ru → overpass-api.de → overpass.kumi.systems, 20s timeout each; skip chains/national brands like Taco Bell, Supercuts, Earl of Sandwich where tags brand:wikidata exists; dedupe by osmId)
- `POST /api/businesses` {name, website?, category?, address?} → Business (created, status scouted). If only name, try Overpass name search within 1.5km; else create from given fields.
- `POST /api/businesses/:id/build` → 202 {ok:true}; runs pipeline in background (ctx.waitUntil)
- `POST /api/run-block` {limit?=8} → 202; builds all `scouted` businesses with concurrency 3
- `POST /api/businesses/:id/pitch` → Business (regenerated pitch)
- `POST /api/businesses/:id/status` {status: 'contacted'|'replied'} → Business
- `POST /api/businesses/:id/video` → 202 or 400 {error:"Higgsfield key not configured"}
- `POST /api/businesses/:id/video-url` {url} → Business (attach externally rendered ad)
- `DELETE /api/businesses/:id` → {ok:true} (status removed; site shows removed page)
- `POST /api/reset` {confirm:"RESET"} → {ok:true}
- `POST /api/stripe/webhook` → verifies with STRIPE_WEBHOOK_SECRET if set (reject if set and invalid); on checkout.session.completed with client_reference_id → markPaid
- `GET  /claimed?session_id=…` → if STRIPE_SECRET_KEY verify session via API (paid + client_reference_id) → markPaid; else mark `paid` with `paymentVerified:false`; render thank-you page
- `GET  /s/:id` → site HTML (renderSite); `GET /s/:id/claim` → 302 to biz.paymentUrl; `GET /s/:id/remove` → confirm page with POST form → DELETE flow (`POST /s/:id/remove`)
- `GET  /img/:key` → KV bytes (content-type image/jpeg or png, cache 1 day)
- WebSocket: `/agents/hq/main` (Agents SDK routeAgentRequest). Server→client JSON messages:
  `{type:"snapshot", snapshot}` on connect; `{type:"event", event}`; `{type:"business", business}`; `{type:"stats", stats}`; `{type:"removed", id}`.
  Client ignores unknown message types (the Agents SDK sends its own `cf_agent_*` messages).

## Frontend (Mission Control) — must feel like a cinematic ops room
Dark, editorial. Fonts: "Instrument Serif" (display), "Inter" (UI), "JetBrains Mono" (numbers/timers).
Colors: bg #0A0A0B, panel #121214, line #232327, text #F4F1EA, muted #8A877F, signal #FF5B1F, money #3DDC84, warn #FFC247, error #FF4D4D.
Layout: top bar (wordmark, tagline, connection dot, integrations pills) → stats ribbon (Scouted · Built · Taste-passed · Contacted · Replied · Paid · Revenue · Spend) →
three columns: Map (Leaflet, dark tiles, pins by status, HQ pin) | Business grid (cards w/ hero thumb, name, category, taste ring, status chip, actions) | Agent channel (Slack-like live feed, agent monograms, filter chips).
Primary actions: "Scout the block", "Run the block", "Live challenge" (speedrun modal: input business name/website → big split timer with splits Scout/Archivist/Builder/Critic/Director/Closer and live score versions, ends with "Open site" + "QR"), per-card: Build/Rebuild, Open site, Details (drawer: brand kit palette/fonts/voice, score history v1→vN with critic notes, timings, pitch w/ Copy + mailto, payment link copy, video attach/start, remove), Mark contacted, Mark replied.
Money events → toast + subtle confetti; revenue counter animates. Keyboard: `L` live challenge, `S` scout, `R` run block, `Esc` close.
Responsive down to 375px (columns stack). Accessible focus states.
