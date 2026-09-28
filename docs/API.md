# Cold Open API

Every endpoint Mission Control uses is public and documented here, so you can drive Cold Open from a script, a bot or another agent.

- **Base URL:** `https://coldopen.vnarasingamoorthy.workers.dev` (or your own `PUBLIC_URL`)
- **Format:** JSON in, JSON out, unless a route says otherwise (preview sites and the post-checkout page return HTML, images return bytes).
- **Routing:** the Worker (`src/index.ts`) forwards `/api/*` to the HQ Durable Object instance `main`. `/s/*`, `/img/*` and `/claimed` are handled in the Worker. Everything else is static assets from `public/`.
- **Types:** `Business`, `Brand`, `SiteSpec`, `ScoreVersion`, `AgentEvent`, `Stats` and `Snapshot` are defined in [`src/types.ts`](../src/types.ts).
- **Errors:** failures return a non-2xx status with a JSON body of the form `{ "error": "human readable message" }`.
- **Auth:** none. This is a hackathon demo that operates on public data. If you deploy your own copy for real use, put the `/api/*` routes behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) or similar. The owner-facing routes (`/s/:id`, `/s/:id/claim`, `/s/:id/remove`, `/claimed`) and the Stripe webhook must stay public.

```bash
export CO=https://coldopen.vnarasingamoorthy.workers.dev
```

## Contents

- [State](#state): `GET /api/state`, `GET /api/config`
- [Scouting](#scouting): `POST /api/scout`, `POST /api/businesses`
- [Building](#building): `POST /api/businesses/:id/build`, `POST /api/run-block`
- [Outreach](#outreach): `POST /api/businesses/:id/pitch`, `POST /api/businesses/:id/status`
- [Video](#video): `POST /api/businesses/:id/video`, `POST /api/businesses/:id/video-url`
- [Removal and reset](#removal-and-reset): `DELETE /api/businesses/:id`, `POST /api/reset`
- [Payments](#payments): `POST /api/stripe/webhook`, `GET /claimed`
- [Preview sites](#preview-sites): `GET /s/:id`, `GET /s/:id/claim`, `GET|POST /s/:id/remove`
- [Media](#media): `GET /img/:key`
- [WebSocket](#websocket): `/agents/hq/main`

---

## State

### `GET /api/state`

Returns the full `Snapshot`.

```bash
curl -s $CO/api/state | jq '.stats'
```

```jsonc
{
  "businesses": [ /* Business[] */ ],
  "events":     [ /* AgentEvent[], most recent 200, oldest first */ ],
  "stats": {
    "scouted": 0,        // non-removed businesses
    "built": 0,          // reached ready or beyond
    "tastePassed": 0,    // final score >= 85
    "contacted": 0,
    "replied": 0,
    "paid": 0,
    "revenueCents": 0,
    "spendCents": 0,     // estimated model spend
    "avgBuildMs": null,
    "bestBuildMs": null
  }
}
```

### `GET /api/config`

What this deployment is and which integrations are live. Booleans and labels only; secrets are never returned.

```jsonc
{
  "publicUrl": "https://coldopen.vnarasingamoorthy.workers.dev",
  "paymentLink": "https://buy.stripe.com/test_...",
  "hq": { "lat": 37.7786, "lon": -122.3893, "label": "..." },
  "integrations": {
    "claude": false,                  // ANTHROPIC_API_KEY starting with sk-ant-
    "openai": true,                   // OPENAI_API_KEY, or a non-Anthropic sk- key in ANTHROPIC_API_KEY
    "workersAI": true,                // AI binding present and its quota not exhausted
    "workersAIQuotaExhausted": false, // true while the Workers AI quota breaker is open (error 4006)
    "stripeApi": false,               // STRIPE_SECRET_KEY
    "stripeWebhook": false,           // STRIPE_WEBHOOK_SECRET
    "slack": false,                   // SLACK_WEBHOOK_URL
    "higgsfield": false,              // HIGGSFIELD_API_KEY (+ secret)
    "taste": false,                   // TASTE_API_KEY
    "brainbase": false                // BRAINBASE_API_KEY
  },
  "llm": "OpenAI gpt-5-mini",        // the provider at the front of the chain, prettified
  "stripeMode": "test",              // "test" | "live" | null, from the STRIPE_SECRET_KEY prefix
  "tasteBar": 85,                    // Critic pass mark
  "maxVersions": 3,                  // Builder/Critic loop cap
  "priceCents": 4900                 // Launch Pack price
}
```

The LLM chain is Claude (`sk-ant-` key) → OpenAI (`gpt-5-mini` by default, `OPENAI_MODEL` to change it) → Workers AI Llama 3.3 70B → Workers AI gpt-oss-120b. `llm` names the first link that is configured; every critic score also records which provider actually answered.

---

## Scouting

### `POST /api/scout`

Finds independent businesses around `HQ_LAT`/`HQ_LON` using OpenStreetMap Overpass.

| Field | Type | Default | Notes |
|---|---|---|---|
| `radius` | number (meters) | `450` | Clamped to 100–2000 m by HQ |
| `limit` | number | `24` | Maximum places returned, clamped to 1–60 by HQ |

Behavior:

- Queries the mirrors `maps.mail.ru`, `overpass-api.de` and `overpass.kumi.systems` with hedged parallel requests: the next mirror starts after 4.5 s of silence or as soon as the current one fails; the first valid JSON response wins and the others are cancelled. Each mirror has a 20 second timeout. One short retry round follows if the whole chain fails quickly.
- If every mirror still fails, the Scout falls back to a bundled OpenStreetMap snapshot (`src/pipeline/osm-snapshot.json`: 87 elements within 600 m of 101 Townsend St, captured Sep 28, 2026, © OpenStreetMap contributors, ODbL), filtered to the requested radius, and logs that it did so. Same data shape, same chain filter.
- Skips chains and national brands: anything tagged `brand`, `brand:wikidata`, `brand:wikipedia` or `operator:wikidata`, plus a list of well-known chain names that often lack those tags.
- Dedupes by `osmId` and by normalized name, so scouting twice does not create duplicates.
- Returns `409` if a sweep is already running.

```bash
curl -s -X POST $CO/api/scout -H 'content-type: application/json' -d '{"radius":450,"limit":24}' | jq '.total'
```

```jsonc
{ "added": [ /* Business[], status "scouted" */ ], "total": 24 }
```

### `POST /api/businesses`

Adds one business by hand. This is what **Live challenge** calls.

| Field | Type | Required |
|---|---|---|
| `name` | string | yes |
| `website` | string | no |
| `category` | string | no |
| `address` | string | no |

If only `name` is given, HQ looks the name up within 1.5 km of HQ, first on Nominatim (one fast, accent-insensitive request) and then, if that returns nothing, on the Overpass mirror chain, and fills in location, website and tags from the best match. Otherwise the business is created from the fields you sent. Returns the created `Business` with status `scouted`.

```bash
curl -s -X POST $CO/api/businesses -H 'content-type: application/json' \
  -d '{"name":"Example Coffee","website":"https://example.com","category":"cafe"}' | jq '{id, status}'
```

---

## Building

### `POST /api/businesses/:id/build`

Runs the full pipeline for one business in the background (`ctx.waitUntil`) and returns immediately. Also used to **rebuild** a business that is already built.

```bash
curl -s -X POST $CO/api/businesses/example-coffee/build
# 202 {"ok":true}
```

Progress arrives over the [WebSocket](#websocket) as `event` and `business` messages. Status moves through:

```
scouted → extracting → building → critiquing (⟲ up to 3 versions) → directing → ready
```

On failure the business is set to `error` with `biz.error` filled in; the Durable Object keeps running and other builds are unaffected.

If the Durable Object itself restarts while builds are in flight, any business still in `extracting`, `building`, `critiquing` or `directing` is picked up again automatically on the next start (up to six at once). A `System` event in the channel says how many were resumed. The hero step never fails a build: if FLUX (Workers AI), OpenAI images and the business's own `og:image` all fail, the site ships with a typographic hero and a `warn` event says so.

### `POST /api/run-block`

Builds every business with status `scouted`, three at a time.

| Field | Type | Default |
|---|---|---|
| `limit` | number | `8` |

```bash
curl -s -X POST $CO/api/run-block -H 'content-type: application/json' -d '{"limit":8}'
# 202 {"ok":true}
```

---

## Outreach

### `POST /api/businesses/:id/pitch`

Regenerates the Closer's pitch and returns the updated `Business`. `biz.pitch` is `{ subject, body }`. Nothing is sent; Mission Control offers Copy and a `mailto:` link so a person can review and send it.

### `POST /api/businesses/:id/status`

Records manual outreach progress.

| Field | Type | Values |
|---|---|---|
| `status` | string | `"contacted"` or `"replied"` |

Sets `contactedAt` or `repliedAt` and returns the updated `Business`.

```bash
curl -s -X POST $CO/api/businesses/example-coffee/status -H 'content-type: application/json' -d '{"status":"contacted"}' | jq '.status'
```

---

## Video

### `POST /api/businesses/:id/video`

Starts a Higgsfield image-to-video job from the business's hero image. Non-blocking: `biz.video.status` becomes `rendering`, then `ready` with a `url`, or `error` with a message.

- `202 {"ok":true}` when a job was started.
- `400 {"error":"Higgsfield key not configured"}` when `HIGGSFIELD_API_KEY` is not set.

### `POST /api/businesses/:id/video-url`

Attaches a launch ad rendered anywhere else.

| Field | Type |
|---|---|
| `url` | string (http or https) |

Sets `biz.video = { status: "ready", url, provider: "external" }` and returns the `Business`. Works with no keys at all.

---

## Removal and reset

### `DELETE /api/businesses/:id`

Removes a preview. Status becomes `removed`, `/s/:id` renders a removed page from then on, and Mission Control receives a `removed` message. Returns `{"ok":true}`. This is the same takedown the owner triggers from the preview banner.

### `POST /api/reset`

Wipes all businesses and events.

| Field | Type | Required value |
|---|---|---|
| `confirm` | string | `"RESET"` |

Without the exact confirmation string the request is refused.

```bash
curl -s -X POST $CO/api/reset -H 'content-type: application/json' -d '{"confirm":"RESET"}'
```

---

## Payments

The money path uses a Stripe Payment Link. With a test-mode `STRIPE_SECRET_KEY`, the Closer creates a dedicated $49 Payment Link for each business (a Price and a Payment Link named after the business, created idempotently, with the `/claimed` redirect and the business id in metadata), then appends `?client_reference_id=<businessId>`. Without a key, or with a live key, `biz.paymentUrl` is the shared `PAYMENT_LINK` with the same `client_reference_id` appended, so Stripe carries the business id through checkout either way. Payments are then verified twice: on `/claimed` through the Checkout Session API, and through the signed webhook.

### `POST /api/stripe/webhook`

Receives `checkout.session.completed` and marks the business named by `client_reference_id` as paid.

When `STRIPE_WEBHOOK_SECRET` is set, the request is verified per [Stripe's manual verification guide](https://docs.stripe.com/webhooks#verify-manually) with WebCrypto, no SDK:

1. Parse `Stripe-Signature` into `t` and one or more `v1` values.
2. Reject if `t` is more than 5 minutes from now (replay protection).
3. Compute HMAC-SHA256 of `` `${t}.${rawBody}` `` with the endpoint secret.
4. Compare to each `v1` in constant time. No match: reject.

Requests with a missing, malformed, stale or mismatched signature are rejected with a 4xx and never mark anything paid.

When the secret is **not** set, events cannot be signature-checked. That is acceptable for a test-mode demo and not acceptable for real money. Set the secret. `scripts/setup-secrets.sh` can register the endpoint and store the secret for you through the Stripe CLI.

Local testing with the Stripe CLI:

```bash
stripe listen --forward-to localhost:8787/api/stripe/webhook
stripe trigger checkout.session.completed
```

### `GET /claimed?session_id={CHECKOUT_SESSION_ID}`

Where Stripe sends the owner after paying. Returns an HTML thank-you page.

- With `STRIPE_SECRET_KEY`: retrieves the Checkout Session from the Stripe API, requires it to be paid and to carry a `client_reference_id`, then marks that business paid with `paymentVerified: true`.
- Without it: marks the business paid with `paymentVerified: false`, so the record is honest about what was checked.

The redirect and the webhook both end in the same `markPaid(id)` on HQ.

---

## Preview sites

### `GET /s/:id`

The generated site, as HTML, rendered by `src/site/render.ts` from `biz.site` and `biz.brand`. Every page:

- carries `<meta name="robots" content="noindex,nofollow">`;
- shows a sticky banner: *"Unofficial concept preview made for {name} by Cold Open — not the official site."* with **Claim it · $49** and **Remove this preview**;
- labels unconfirmed offerings *"Preview — owner to confirm"* without prices, and unknown hours *"Hours — owner to confirm"*.

Removed businesses render a removed page. Unknown ids render a not-found page.

### `GET /s/:id/claim`

`302` redirect to `biz.paymentUrl`.

### `GET /s/:id/remove` and `POST /s/:id/remove`

`GET` shows a confirmation page with a single button. `POST` performs the removal, exactly like `DELETE /api/businesses/:id`, and shows the removed page. Two clicks from banner to gone, no account needed.

---

## Media

### `GET /img/:key`

Serves hero image bytes from the `MEDIA` KV namespace. Keys look like `img:{businessId}:{n}`, and `biz.heroImage` already holds the full path (`/img/img:{id}:{n}`). The content type is sniffed from the bytes (`image/jpeg`, `image/png` or `image/webp`), the KV metadata records which source made the image (`flux-1-schnell`, `flux-2-klein-4b`, `gpt-image-1`, `dall-e-3` or `their og:image`), and responses are cacheable for one day.

---

## WebSocket

### `/agents/hq/main`

The live stream behind Mission Control, served by the [Agents SDK](https://developers.cloudflare.com/agents/) through `routeAgentRequest`.

```js
const ws = new WebSocket("wss://coldopen.vnarasingamoorthy.workers.dev/agents/hq/main");
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  switch (msg.type) {
    case "snapshot": /* msg.snapshot: Snapshot, sent once on connect */ break;
    case "event":    /* msg.event: AgentEvent */ break;
    case "business": /* msg.business: Business, full object after every change */ break;
    case "stats":    /* msg.stats: Stats */ break;
    case "removed":  /* msg.id: string */ break;
    default:         /* ignore unknown types, including the SDK's own cf_agent_* messages */
  }
};
```

`AgentEvent`:

```jsonc
{
  "id": 42,
  "ts": 1790000000000,
  "agent": "Critic",            // Scout | Archivist | Builder | Critic | Director | Closer | CFO | System
  "kind": "warn",               // info | success | warn | error | money
  "text": "v1 scored 71. Headline is generic; use their own words.",
  "bizId": "example-coffee",
  "data": { "version": 1, "score": 71 }
}
```

The example values above are illustrative. Real events carry whatever the agents actually did.

Clients should treat the `business` message as authoritative and replace their copy of that business wholesale.
