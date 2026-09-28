# Integrations

Cold Open runs completely on Cloudflare: Workers AI, KV and a Durable Object. Nothing else is
needed. Each optional secret adds one more real service. When a secret is missing, that feature
turns off quietly and the integration pill in Mission Control stays grey. The app never fakes a
missing integration.

| Integration | Secret(s) | What it adds | Without it | Code |
|---|---|---|---|---|
| Workers AI | none (binding `AI`) | The zero-key LLM (Llama 3.3 70B, then gpt-oss-120b) and the first two hero-image attempts (FLUX.1 schnell, FLUX.2 klein) | Always on, unless the daily quota is exhausted (error 4006), in which case a circuit breaker skips it | `src/llm.ts`, `src/pipeline/director.ts` |
| Claude | `ANTHROPIC_API_KEY` starting `sk-ant-` (+ var `CLAUDE_MODEL`) | Claude goes to the front of the LLM chain, ahead of OpenAI and Workers AI | The chain starts at OpenAI or Workers AI | `src/llm.ts` |
| OpenAI | `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`, default `gpt-5-mini`) | OpenAI does the agents' reasoning (behind Claude if both are set), and `gpt-image-1` → `dall-e-3` render hero images when Workers AI cannot. **The live deployment runs on this.** | Llama 3.3 70B on Workers AI; hero falls straight from FLUX to the business's own `og:image` | `src/integrations/openai.ts`, `src/llm.ts`, `src/pipeline/director.ts` |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Payments are verified server-side through the Checkout Session API and the signed webhook, and each business gets its own dedicated test-mode Payment Link | Shared test link; a claim is recorded as `paymentVerified:false` | `src/integrations/stripe.ts` |
| Slack | `SLACK_WEBHOOK_URL` | Mirrors the agent channel into a real Slack channel | Feed shows in Mission Control only | `src/integrations/slack.ts` |
| Higgsfield | `HIGGSFIELD_API_KEY` + `HIGGSFIELD_API_SECRET` | A 5 s cinematic image-to-video "launch ad" made from the hero image | Hero still only; you can attach an external video URL by hand | `src/integrations/higgsfield.ts` |
| Taste Labs | `TASTE_API_KEY` | Brand extraction measured by the Taste Engine, and an independent brand-adherence score | The Archivist and Critic use the LLM and HTML parsing only | `src/integrations/taste.ts` |
| Brainbase Labs | `BRAINBASE_API_KEY` | An independent second-opinion review of every shipped site by a Brainbase managed agent | The in-house Critic is the only reviewer | `src/integrations/brainbase.ts` |

`GET /api/config` returns `integrations: { claude, openai, workersAI, workersAIQuotaExhausted, stripeApi, stripeWebhook, slack, higgsfield, taste, brainbase }`
plus `llm`, the label of the provider at the front of the chain (for example `"OpenAI gpt-5-mini"`). Each secret-gated value is true only when
its secret is present; `workersAI` is false and `workersAIQuotaExhausted` is true while the quota breaker is open. The pills in the top bar read these values.

---

## 1. Setting secrets: `scripts/setup-secrets.sh`

```bash
cd coldopen
npx wrangler login          # once
./scripts/setup-secrets.sh  # interactive
```

What the script does:

1. It asks for each secret in turn with `read -s`, so what you type is never echoed. Press Enter to skip one.
2. It pipes each value into `npx wrangler secret put <NAME>` for the `coldopen` Worker. Values are never printed,
   logged or written to disk. Each line reports only `✓ NAME set`, `✗ NAME failed` or `– NAME skipped`.
3. **Stripe shortcut.** If the Stripe CLI is installed and logged in (`~/.config/stripe/config.toml` exists), the
   script offers two things. It can use the test-mode key from your `[default]` profile (it accepts only
   `sk_test_…` or `rk_test_…`). It can also register the production webhook
   `https://coldopen.vnarasingamoorthy.workers.dev/api/stripe/webhook` for `checkout.session.completed` and
   store the returned `whsec_…` signing secret as `STRIPE_WEBHOOK_SECRET`.
4. The order is: Claude, Stripe, Slack, Higgsfield (key, then secret), Taste Labs. The script has no OpenAI prompt: set that one
   with `npx wrangler secret put OPENAI_API_KEY`. (An OpenAI `sk-` key pasted at the Anthropic prompt also works, because keys are
   routed by prefix, but the dedicated secret is clearer.)

Secrets take effect on the next request. You do not need to redeploy. Reload Mission Control and the pills update.

Manual alternatives:

```bash
npx wrangler secret put TASTE_API_KEY       # paste when prompted
npx wrangler secret list                    # names only, never values
npx wrangler secret delete SLACK_WEBHOOK_URL
```

For local `wrangler dev`, put the same names in `.dev.vars`, one per line as `NAME=value`, and keep that file out of git.

---

## 2. Workers AI (always on)

The binding is `"ai": { "binding": "AI" }` in `wrangler.jsonc`. There is no key: usage is billed to the Cloudflare account.

| Use | Model |
|---|---|
| Agent reasoning (last in the chain; primary only when there is neither a Claude nor an OpenAI key) | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, then `@cf/openai/gpt-oss-120b` |
| Hero image (Director), first two attempts | `@cf/black-forest-labs/flux-1-schnell`, then `@cf/black-forest-labs/flux-2-klein-4b` |

Hero image bytes are stored in the KV namespace `MEDIA` under `img:{bizId}:{n}` and served from `GET /img/:key`.

**Quota circuit breaker.** On the free plan, Workers AI returns error `4006` once the day's allocation is used up. `aiRun()` in
`src/llm.ts` recognises that message (and the "daily free allocation" / "neurons" wording), opens a breaker for 10 minutes or
until 00:00 UTC, whichever is sooner, and every Workers AI call in that window fails fast instead of waiting on a timeout. The
LLM chain moves on to the next provider and the Director skips straight to OpenAI images or the business's `og:image`. A later
success closes the breaker. `GET /api/config` reports the state as `integrations.workersAI: false` and
`integrations.workersAIQuotaExhausted: true`, and the Workers AI pill in Mission Control explains it.

**Verify:** `curl -s https://coldopen.vnarasingamoorthy.workers.dev/api/config | jq .integrations.workersAI` returns `true`.

## 3. Claude (optional)

- Secret: `ANTHROPIC_API_KEY`, and it must start with `sk-ant-`. A key with any other `sk-` prefix stored in this secret is
  treated as an OpenAI key (see the next section). Var: `CLAUDE_MODEL` (default `"claude-sonnet-5"`, set in `wrangler.jsonc`).
- `llmJSON()` calls the Anthropic Messages API (`POST https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`)
  with a 45 s timeout and a low effort hint on models that accept one.
  If Claude fails, it falls back to OpenAI (if keyed), then Workers AI Llama, then gpt-oss, so a Claude outage never blocks a build.
- The provider that actually answered is recorded on every critic score (`ScoreVersion.provider`) and shown in the UI.
  Costs in the CFO ledger are estimates calculated from token counts.

**Verify:** `integrations.claude` is `true` and `llm` reports your `CLAUDE_MODEL`. Critic scores then show `provider: "claude-sonnet-5"` (or your model).

## 4. OpenAI (optional; what the live demo runs on)

- Secret: `OPENAI_API_KEY`. Var: `OPENAI_MODEL` (default `gpt-5-mini`; not in `wrangler.jsonc`, add it to `vars` or `.dev.vars` to change it).
  `openaiKey()` in `src/integrations/openai.ts` takes `OPENAI_API_KEY` if it starts with `sk-`, otherwise a non-`sk-ant-` `sk-` key found in
  `ANTHROPIC_API_KEY`, so a key pasted into the wrong secret still routes to the right API.
- **Text.** `openaiComplete()` calls `POST https://api.openai.com/v1/chat/completions` with `response_format: { type: "json_object" }`
  and a 45 s timeout. It tries `OPENAI_MODEL`, then `gpt-5-mini`, `gpt-4.1-mini` and `gpt-4o-mini`, moving on when a model is unknown
  or rejects a parameter and stopping on 401, 403 or 429. Reasoning models (`gpt-5*`, `o*`) get `max_completion_tokens` and
  `reasoning_effort: "low"`; the others get `max_tokens` and the requested temperature. Position in the chain: after Claude, before Workers AI.
- **Images.** In the Director, after both FLUX models (or immediately, while the Workers AI breaker is open): `gpt-image-1` at
  1536×1024, quality `low`, JPEG at 85 (falling back to the default PNG if the API rejects `output_format`), then `dall-e-3` at
  1792×1024, standard quality. Both go through `POST /v1/images/generations` and land in KV like any other hero. Estimated cost per
  image for the CFO: about 2¢ for gpt-image-1, 8¢ for dall-e-3.
- The label recorded on scores and events is `OpenAI <model>`, for example `OpenAI gpt-5-mini`.

**Verify:** `curl -s https://coldopen.vnarasingamoorthy.workers.dev/api/config | jq '{openai: .integrations.openai, llm}'` shows
`openai: true` and, with no Claude key, `llm: "OpenAI gpt-5-mini"`. Build a business: the Critic's scores carry `provider: "OpenAI gpt-5-mini"`.

## 5. Stripe (test mode)

Without any secret, each business's claim link is the shared TEST Payment Link with the business attached:
`https://buy.stripe.com/test_cNieV5am70px0O47jK0Ny00?client_reference_id=<businessId>` ($49 "Cold Open Launch Pack").
After checkout, Stripe redirects to `/claimed?session_id={CHECKOUT_SESSION_ID}`.

| Secret | Effect |
|---|---|
| `STRIPE_SECRET_KEY` (`sk_test_…` or `rk_test_…`) | `/claimed` fetches the Checkout Session (`GET /v1/checkout/sessions/:id`) and marks the business paid only if the session is `paid` and its `client_reference_id` matches. The Closer also creates a dedicated $49 Payment Link per business: a Price (`POST /v1/prices`, product "Cold Open Launch Pack: {name}") and a Payment Link (`POST /v1/payment_links`) with the `/claimed` redirect and `business_id` in metadata, both with idempotency keys. Test-mode keys only; with a live key the shared `PAYMENT_LINK` is used instead so a demo can never create live charges. |
| `STRIPE_WEBHOOK_SECRET` (`whsec_…`) | `POST /api/stripe/webhook` checks `Stripe-Signature` with WebCrypto HMAC-SHA256 and a 5-minute tolerance. Invalid signatures are rejected. `checkout.session.completed` that carries a `client_reference_id` calls `markPaid`. |

Without the secret key, a visit to `/claimed` still records the claim, marked `paymentVerified:false`, and the UI
labels it unverified. **Verify:** open a site, click "Claim it · $49", and pay with a
[Stripe test card](https://docs.stripe.com/testing). You land on `/claimed`, and Mission Control plays a money
toast and bumps Revenue.

## 6. Slack (optional)

1. At api.slack.com/apps, choose Create App, then Incoming Webhooks, turn it on, and add a webhook to a channel.
2. Store the `https://hooks.slack.com/services/…` URL as `SLACK_WEBHOOK_URL`.

What gets posted: the notable moments of the agent channel (sites going live, replies, payments) as mrkdwn messages with links.
Posts are serialized about 1 s apart to respect Slack's webhook rate limit. Failures are logged and never block the pipeline.

---

## 7. Higgsfield: cinematic launch ad (`src/integrations/higgsfield.ts`)

### API facts (from docs.higgsfield.ai, checked 2026-09-28; base URL and 401 envelope confirmed live)

| | |
|---|---|
| Base URL | `https://api.higgsfield.ai` |
| Auth | `Authorization: Key {api_key_id}:{api_key_secret}` (the legacy `hf-api-key`/`hf-secret` headers also work but are not used) |
| Submit | `POST /{model-endpoint-id}` with a JSON body. Response: `{ status:"queued", request_id, status_url, cancel_url }` |
| Poll | `GET /requests/{request_id}/status`. Response: `{ status, request_id, video?: { url }, error? }` |
| Statuses | `queued`, `in_progress` (not terminal); `completed`, `failed`, `nsfw`, `canceled` (terminal) |
| Upload | `POST /files/generate-upload-url {content_type}` returns `{ public_url, upload_url, upload_headers }`, then `PUT` the bytes to `upload_url` with exactly those headers |
| Errors | `{ "detail": "..." }` (for 422 it is a list). 400 bad input or concurrency limit reached · 401 credentials · 403 credits · 404 not found · 422 validation · 423/503 model unavailable · 5xx retry |
| Retention | Output URLs are kept for at least 7 days. Failed and NSFW jobs are refunded. |

### Credentials

Create a key in the [Higgsfield Console](https://console.higgsfield.ai). A key has two parts, a key ID and a secret.
Set `HIGGSFIELD_API_KEY` to the ID and `HIGGSFIELD_API_SECRET` to the secret. Alternatively, put both into
`HIGGSFIELD_API_KEY` as `id:secret`, which is the SDKs' `HF_CREDENTIALS` format. `higgsfieldEnabled(env)` is true only
when both parts are present, so the UI never shows Higgsfield as available when authentication is bound to fail.

### Models

| Order | Endpoint id | Body sent |
|---|---|---|
| 1 | `kling-video/v2.5-turbo/standard/image-to-video` | `{prompt, image_url, duration:5, cfg_scale:0.5, negative_prompt}` |
| 2 | `minimax/hailuo-2.3/standard/image-to-video` | `{prompt, image_url, duration:6, prompt_optimizer:true}` (Hailuo accepts only 6 or 10 s) |
| 3 | `kling-video/v3.0-turbo/image-to-video` | `{prompt, image_url, duration:5, resolution:"720p"}` |

Kling 2.5 Turbo Standard is the default because it appears in Higgsfield's OpenAPI spec, defaults to a 5 s clip, and is
the fastest and cheapest cinematic option. The next model is tried **only** when the API says a model is unavailable to
the account (404/423/503). Submissions are not idempotent, so a submit that times out is **never** retried; a retry
could render and bill twice. To pin a different model without code changes, add `"HIGGSFIELD_MODEL": "<endpoint id>"`
to `vars` in `wrangler.jsonc`. It is read with an index lookup, so `types.ts` is unchanged. Unknown ids receive only
`{prompt, image_url}`.

### How the image reaches Higgsfield

`startVideo(env, { imageUrl, prompt })` accepts an absolute URL, a path relative to `PUBLIC_URL` (the Director
passes `biz.heroImage`, for example `/img/img:blue-bottle:1`), or a `data:` URI.

- If the path is one of our own `/img/<kv-key>` images, the bytes are read straight from `MEDIA` and uploaded to
  Higgsfield storage using the presigned-upload flow. Credentials are never sent to the presigned URL. As a result the
  render does not depend on Higgsfield being able to fetch this Worker, which also makes local dev work.
- If that upload fails, it falls back to the public `https://…/img/…` URL. Localhost and private hosts are rejected
  with a clear error.

### Function contracts

```ts
higgsfieldEnabled(env): boolean
startVideo(env, { imageUrl, prompt }): Promise<{ jobId, model, modelLabel }>   // jobId = Higgsfield request_id
pollVideo(env, jobId): Promise<{ status: 'rendering'|'ready'|'error'; url?; error? }>
suggestVideoPrompt(brand, category?): string    // motion prompt built from the brand's own vibe and keywords; no text or logos
higgsfieldModelLabel(env): string               // e.g. "Kling 2.5 Turbo" for the agent channel
class HiggsfieldError extends Error { status?; retryable; correlationId? }
```

- Every request has a 30 s budget (`AbortSignal.timeout`).
- `pollVideo` reports job outcomes as a status. `completed` maps to `ready` with the mp4 URL. `failed`, `nsfw` and
  `canceled` map to `error` with a readable reason.
- Transport problems throw a `HiggsfieldError`. Network errors, timeouts, 429 and 5xx set `retryable:true`, so keep
  polling. 401 and 404 set `retryable:false`, so mark the video as errored.
- Suggested polling: every 10 s, per the docs' 2 s to 10 s backoff guidance, for up to about 10 minutes. Start the
  job without blocking the pipeline, and store `{status:"rendering", jobId, provider:"higgsfield"}` in `biz.video`.

```ts
// Director (non-blocking)
if (higgsfieldEnabled(env) && biz.heroImage) {
  const { jobId, modelLabel } = await startVideo(env, { imageUrl: biz.heroImage, prompt: suggestVideoPrompt(brand, biz.category) });
  biz.video = { status: "rendering", jobId, provider: "higgsfield" };
}
// Poller (alarm / schedule)
try {
  const r = await pollVideo(env, biz.video.jobId!);
  if (r.status !== "rendering") biz.video = { ...biz.video, status: r.status, url: r.url, error: r.error };
} catch (e) {
  if (!(e instanceof HiggsfieldError && e.retryable)) biz.video = { ...biz.video, status: "error", error: (e as Error).message };
}
```

### Verify

```bash
# Replace with your own credentials in your shell. Never commit them.
curl -s https://api.higgsfield.ai/requests/00000000-0000-0000-0000-000000000000/status \
  -H "Authorization: Key $HF_KEY_ID:$HF_KEY_SECRET"
# 401 {"detail":"Invalid credentials"}: the credentials are wrong
# 404: the credentials are good (that request id does not exist)
```

Then click **Start video** in a business drawer. The agent channel shows the Director starting the job, and the card
shows the clip when the status turns `ready`. To confirm which models your account can use, open each endpoint's
Playground in the console.

### Assumptions (marked `// ASSUMPTION` in code)

1. `completed` video responses carry `video.url`, which is documented. `mov`/`videos` are read only as defensive fallbacks.
2. The 400 "concurrency reached" case is recognised by its message text; the docs give no machine code for it.
3. `/img/<key>` maps 1:1 to a MEDIA KV key, as SPEC says (`heroImage = "/img/img:{id}:{n}"`).
4. The Kling 3.0 Turbo and Hailuo endpoint ids come from the model pages. Access depends on the account. Check with the console Playground.

---

## 8. Taste Labs: Brand API (`src/integrations/taste.ts`)

### API facts (from docs.tastelabs.com and its OpenAPI spec, checked 2026-09-28; base URL and 401 envelope confirmed live)

| | |
|---|---|
| Base URL | `https://api.tastelabs.com` |
| Auth | `X-API-Key: <key>`. Keys come from the [Engine dashboard](https://engine.tastelabs.com/app/api-keys) and can expire (401). |
| Extractor (v1.0.0) | `POST /design/submissions {url, force?, enable_deep_analysis?}` returns 202 `{submission_id}`. Then `GET /design/submissions/{id}/result?sections=profile,colors,typography` returns 200, possibly partial (`{status, result:{design_system}}`), or 409 `NOT_READY`, or 404. |
| Verifier (alpha) | `POST /judge/brand-adherence {reference_url, source_url}` returns 202 `{job_id}`. Then `GET /judge/brand-adherence/{job_id}/result` returns 200 `{status, score 0..1, recommendations[], fixes[]}`, or 409 `NOT_READY`, or 424 (failed, stop polling). |
| Search (alpha) | `POST /search {query, depth:"fast", top_k, filters?}` is synchronous and returns `{results:[{url, brand_name, identity_paragraph, palette, typography, tags, screenshot_url}]}` |
| Errors | `{ "detail": { "error": CODE, "message" } }`: 401 UNAUTHORIZED · 402 INSUFFICIENT_CREDITS · 403 FORBIDDEN · 404 · 409 NOT_READY · 422 validation · 424 BRAND_ADHERENCE_FAILED |
| Latency | A fresh extraction or verification takes **3 to 5 minutes**. Cached URLs return quickly. Submissions and searches cost credits, which are refunded on failure. |

### Why the caching exists

Every function is capped at 30 s, but a Taste job on a fresh URL takes minutes. So submission ids and verifier job
ids are remembered in memory and in KV `MEDIA` under `taste:*` keys:

| KV key | TTL | Holds |
|---|---|---|
| `taste:sub:{sha256(url)}` | 3 days | Extraction `submission_id` (reused instead of paying for a new submission) |
| `taste:brand:{sha256(url)}` | 7 days | The completed extraction, already mapped to `Partial<Brand>`, so later builds are instant and free |
| `taste:job:{sha256(ref+source)}` | 6 h | `{jobId, htmlHash, at, done}` for verifier jobs |

A call that runs out of time leaves the job running. The next call for the same URL picks up the result.
`tastePrewarmBrand(env, url)` starts an extraction without waiting, for example when a business is scouted or when
"Run the block" queues it, so the result is ready by the time the Archivist asks for it.

### Extraction: how `design_system` maps to `Brand`

| Brand field | Source in `design_system` |
|---|---|
| `name` | `profile.brand_name` |
| `voice` | `profile.copy_tone[]`, lowercased and comma-joined |
| `vibe` | `profile.brand_signature`, or `style_classification.primary_style` / `secondary_style` |
| `keywords` | `profile.visual_language.keywords` plus the style names plus `profile.industry` (at most 10) |
| `palette` | `colors.baseline[]` and `colors.secondary[]` entries (`hex`, `alpha`, `name`, `type`, `rules.when_to_use[]`). Roles are chosen from the labels first (background/surface, text/body, primary/brand/CTA, accent/link, secondary/muted), then by colour maths: most extreme neutral for background, highest WCAG contrast for text (at least 4.5:1), highest chroma for primary, and an accent at least 30° of hue away. Translucent entries (alpha below 0.85) and `shades[]` are ignored. Any role that has to be derived is labelled "(derived)" in `sourceSignals`. At least 2 real colours are required. |
| `fonts` | The first non-generic family in `typography.titles[]` and `typography.paragraphs[]` (`technical.font_family_css`, `specs.font_family`). Applied **only if both families are served by Google Fonts**, checked live against `fonts.googleapis.com/css2`. Licensed faces are reported in `sourceSignals` but not applied. |
| `sourceSignals` | `"Taste Labs Brand API extraction"`, marked "(partial, still running)" when incomplete, followed by name, tone, style, palette and typography lines |

The mapping never sets `offerings`, `story` or `tagline`. Those must come from the business's own site or be labelled
"owner to confirm". **Recommended merge in the Archivist:** run `tasteExtractBrand` in parallel with the HTML
fetch and LLM extraction, for example `Promise.all([...])` with `{ waitMs: 20_000 }`. Prefer Taste's palette and fonts,
because they are measured rather than guessed. Keep your own offerings and story, and concatenate the `sourceSignals` arrays.

### Verification: brand-adherence score

The Verifier crawls **two live URLs**. It cannot accept raw HTML. So `tasteScore` needs:

- `url`: the public URL of the generated page (`${PUBLIC_URL}/s/${id}`), which must already serve the version being
  scored. Save `biz.site` before calling.
- a reference: `referenceUrl` (pass `biz.website`), or else the first http(s) URL found in `brand.sourceSignals`.
  A business with no website has no reference brand, so the function returns `null`. It also returns `null` when
  both URLs share a host.

```ts
tasteEnabled(env): boolean
tasteExtractBrand(env, url, { waitMs? }?): Promise<Partial<Brand> | null>
tastePrewarmBrand(env, url): Promise<boolean>
tasteScore(env, { brand, html, url?, referenceUrl?, waitMs? }): Promise<{ score: 0-100; notes: string[] } | null>
tasteStartAdherence(env, { referenceUrl, sourceUrl }): Promise<{ jobId } | null>
tasteGetAdherence(env, jobId): Promise<{ status:'pending'|'ready'|'error'; score?; notes?; step?; error? } | null>
tasteSearch(env, query, { topK?, category? }?): Promise<TasteSearchCard[] | null>
```

- `score` is `round(verdict.score × 100)`. `notes` holds up to 5 `recommendations` (worst first, with exact target
  values) plus up to 3 formatted `fixes`, for example `Fix (snap to token): font_size 44px → 48px`. They can be fed
  straight back into `composeSite` as critic notes.
- Job reuse: the same page HTML reuses a finished verdict for up to 6 h. A **newer** HTML version piggybacks only on a
  job that is still running and less than 10 minutes old, so a fast critic loop (v1, v2, v3) does not pay for three
  jobs of 3 to 5 minutes each.
- **Recommended pattern.** A verdict takes minutes, so do not block the 85-point critic loop on it. After the business
  reaches `ready`, call `tasteStartAdherence`, then poll `tasteGetAdherence` every 20 to 30 s for up to about 10 minutes.
  When it returns `ready`, append a `ScoreVersion` with `{ version: site.version, score, notes, slopHits: [], provider: "taste-labs" }`
  and emit a Critic event such as "Taste Labs verified 82/100 against the real brand". `null` means transient, so try
  again. `error` is terminal.
- `tasteSearch` looks through the curated corpus. It is useful for businesses with no website: search
  "warm neighborhood bakery, hand-drawn, cream and terracotta" and use the cards' palettes as inspiration.
  `category` becomes a hard `industry` filter only for clear cases (restaurant, beverage, food, hospitality, beauty,
  wellness, fashion).

**Contract: no taste function throws.** Failures are logged as `[taste] …`. The key never appears in logs. The
function returns `null` (or `false`), so Taste Labs can only ever upgrade a build.

### Verify

```bash
curl -s https://api.tastelabs.com/design/me -H "X-API-Key: $TASTE_API_KEY"
# 200 with your identity: the key works. 401 {"detail":{"error":"UNAUTHORIZED",...}}: bad or expired key.
```

Then build a scouted business that has a website. The Archivist's event lists the "Taste Labs …" signals, and the
drawer's brand kit shows the measured palette. A second build of the same URL is served from `taste:brand:*` with no
credits spent.

### Assumptions (marked `// ASSUMPTION` in code)

1. The inner shapes of `colors` and `typography` are taken from the Taste Engine agent skills (Taste-AI/skills:
   `baseline[]`/`secondary[]` with `hex`, `alpha`, `rules.when_to_use`; `titles`/`paragraphs` variants with
   `technical.font_family_css`). The OpenAPI spec types `design_system` only as an open object. If the shape moves,
   the parser walks the section for any `{hex}` objects and `font_family` strings instead.
2. `alpha` is 0 to 1. Values above 1 are treated as percentages.
3. The Verifier `score` is 0 to 1, as documented. Values above 1 are treated as already being percentages, because
   the Verifier is alpha and its shapes may still change.
4. If `?sections=` is ever rejected with 422, polling falls back to the full document.
5. Partial extraction results (`200` while still running) are used when the time budget runs out. Which sections
   arrive first is not documented.

---

## 9. Brainbase Labs: independent second opinion (`src/integrations/brainbase.ts`)

Cold Open's own Critic grades every draft, but it is part of the same pipeline that built the site. When
`BRAINBASE_API_KEY` is set, every business that reaches `ready` is also sent to a Brainbase Labs managed agent. That
agent runs in its own sandbox, fetches the live preview (`/s/:id`) cold, and returns a two-sentence verdict and a
0-100 score. The review runs in the background after the build finishes. It never delays or fails a build, and it
has a hard 60 s budget.

In the agent channel it appears as two `Critic` events:

- `info`: "Asking a Brainbase Labs agent (harness claude_code) for an independent second opinion on …"
- `success` (score ≥ 85) or `info`: "Brainbase second opinion (harness claude_code): 91 — …", with
  `data: { provider: "brainbase", threadId, traceUrl?, score, model, ms }`. If the review fails or times out, a
  `warn` event says so and the shipped score stands.

The review is stored only as agent events. The shipped score (`biz.scores`) is never changed.

### API facts (from docs.brainbaselabs.com/api, checked 2026-09-28)

| | |
|---|---|
| Base URL | `https://api.brainbaselabs.com` |
| Auth | `Authorization: Bearer $BRAINBASE_API_KEY` |
| Create | `POST /v2/threads` `{ agent: { harness, model?, instructions }, input, title?, metadata? }` → `{ thread_id, agent_id, status }` |
| Poll | `GET /v2/threads/{thread_id}` → `{ id, status, status_info, … }` |
| Status | `running`, `idle`, `success`, `fail`, `need_more_info`. The docs' own poll loop waits while `status == "running"`. |
| Transcript | `GET /v2/threads/{thread_id}/messages?limit=N` → `{ items: [{ role, content, … }] }`. The docs read the answer from the last item. |
| Harnesses | `claude_code` (default), `codex`, `cursor`, `factory`, `kafka_cloud`, `opencode`, `qoder`, `qwen` |

We use the `claude_code` harness, which is the documented default and can fetch web pages itself, with
`claude-haiku-4-5-20251001`. That is the smallest Anthropic model in Brainbase's model list. Polling runs every 3 s.
The transcript is read even if polling runs out of time, because the answer may already be there. The legacy
`brainbase-python-sdk` covers the older Workers/voice API and not `/v2/threads`, so this integration follows the
v2 HTTP docs directly.

### Credentials

1. Sign in at [app.brainbaselabs.com](https://app.brainbaselabs.com). New accounts include free credits.
2. Create an API key in the app. The docs say only "create an API key from Brainbase" and do not give the exact menu path.
3. Store it as a Worker secret. No redeploy is needed.

```bash
npx wrangler secret put BRAINBASE_API_KEY
```

`/api/config` then reports `integrations.brainbase: true`, and the next build that ships gets a second opinion.
Each review starts one Brainbase thread, which is one sandbox run on your Brainbase credits.

### Verify

```bash
# Replace with your own key in your shell. Never commit it.
curl -s https://api.brainbaselabs.com/v2/threads -H "Authorization: Bearer $BRAINBASE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"agent":{"harness":"claude_code"},"input":"Reply with the word ok."}'
# → {"thread_id": "...", "agent_id": "...", "status": "running"}
```

### Assumptions (not covered by the docs)

1. **Model per harness.** The docs list models and harnesses but do not say which models each harness accepts. If
   `POST /v2/threads` rejects the Haiku spec with a 4xx other than 401/403, the call retries once with no `model`,
   so the harness default is used. The event data then says `model: "harness default"`.
2. **Message `content` shape.** The docs show `content` only as nullable. The parser accepts a plain string or an
   array of content blocks with `text`.
3. **Trace URL.** The docs do not give a web URL for a thread. `traceUrl` is set only when an API response includes
   `trace_url`, `app_url`, `web_url` or `url`. Otherwise it is omitted rather than guessed. `threadId` is always
   included so the run can be found in the Brainbase app.
4. **Extra in-progress statuses.** `queued`, `pending`, `starting` and `created` are treated like `running` in case
   the API returns them. Anything else ends the polling.
5. **Timeouts.** A thread still running at 60 s is left to finish on Brainbase's side. The interrupt endpoint's
   path for threads is not clearly documented, so it is not called. That run is reported as unavailable.

---

## 10. Security notes

- Secrets are stored only as Worker secrets. They are never sent to the browser, never logged, and never included
  in URLs. The Higgsfield presigned upload receives no credentials.
- The `MEDIA` KV namespace holds both images (`img:*`) and Taste caches (`taste:*`, public brand data only).
  `GET /img/:key` should serve only `img:` keys.
- Generated sites carry `noindex,nofollow` and the "Unofficial concept preview" banner. The Taste crawler is a
  user-directed crawl, so it still reads them.
