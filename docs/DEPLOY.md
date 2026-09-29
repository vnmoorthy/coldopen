# Deploy your own Cold Open

This guide takes you from a fresh clone to your own Cold Open on your own Cloudflare account, with optional Stripe test payments, a custom domain and every integration. The minimum setup (Workers AI, KV and the Durable Object, no API keys) takes about ten minutes.

- [Prerequisites](#prerequisites)
- [1. Clone and install](#1-clone-and-install)
- [2. Log in to Cloudflare](#2-log-in-to-cloudflare)
- [3. Create the KV namespace](#3-create-the-kv-namespace)
- [4. Point the config at your deployment](#4-point-the-config-at-your-deployment)
- [5. Deploy](#5-deploy)
- [6. Add secrets](#6-add-secrets)
- [7. Stripe: checkout, verification and the webhook](#7-stripe-checkout-verification-and-the-webhook)
- [8. Custom domain](#8-custom-domain)
- [9. Local development](#9-local-development)
- [10. Verify it works](#10-verify-it-works)
- [Costs](#costs)
- [Troubleshooting](#troubleshooting)
- [Before you run it in public](#before-you-run-it-in-public)
- [Updating and tearing down](#updating-and-tearing-down)

## Prerequisites

| You need | Why |
|---|---|
| Node.js 22.12 or newer, npm | Wrangler 4 needs Node 22; Vitest 5 (the tests) needs 22.12 or newer |
| A Cloudflare account | Workers, a Durable Object with SQLite storage, KV and Workers AI |
| **Recommended:** the Workers Paid plan | See [Costs](#costs). The Free plan works for a short trial but runs out of Workers AI allocation quickly. |

Optional, each unlocks one upgrade (see the README's graceful-degradation table):

| Optional | Unlocks |
|---|---|
| OpenAI API key (`sk-...`) | `gpt-5-mini` as the brain and `gpt-image-1` / `dall-e-3` hero images. The public demo runs on this. |
| Anthropic API key (`sk-ant-...`) | Claude as the brain, ahead of OpenAI and Workers AI |
| Stripe account in test mode, optionally the Stripe CLI | Checkout, verified payments, per-business Payment Links, signed webhooks |
| Slack incoming webhook | The agent channel mirrored into Slack |
| Higgsfield API key and secret | Image-to-video launch clips |
| Taste Labs API key | Brand extraction from the Taste Labs Brand API |
| Brainbase Labs API key | An independent second-opinion review of every finished site |

## 1. Clone and install

```bash
git clone https://github.com/vnmoorthy/coldopen.git
cd coldopen
npm install
```

## 2. Log in to Cloudflare

```bash
npx wrangler login
npx wrangler whoami     # confirm the account you are deploying to
```

## 3. Create the KV namespace

Hero images live in a KV namespace bound as `MEDIA`. The id in the repository's `wrangler.jsonc` belongs to the public demo's account, so you need your own:

```bash
npx wrangler kv namespace create MEDIA
```

Wrangler prints the new namespace's `id`. Open `wrangler.jsonc` and replace the existing id:

```jsonc
"kv_namespaces": [{ "binding": "MEDIA", "id": "<your namespace id>" }],
```

Keep the binding name `MEDIA`; the code uses it.

## 4. Point the config at your deployment

Edit `wrangler.jsonc`:

```jsonc
{
  "name": "coldopen",                          // your Worker's name; also the workers.dev hostname
  "vars": {
    "PUBLIC_URL": "https://coldopen.<your-subdomain>.workers.dev",
    "PAYMENT_LINK": "",                         // your Stripe TEST Payment Link, see step 7
    "CLAUDE_MODEL": "claude-sonnet-5",
    "HQ_LAT": "37.7786",                        // the block to scout
    "HQ_LON": "-122.3893"
  }
}
```

| Var | What to set | Why it matters |
|---|---|---|
| `name` | Any Worker name | Your URL becomes `https://<name>.<your-subdomain>.workers.dev`. |
| `PUBLIC_URL` | Your deployment's origin, no trailing slash | Used in pitch emails, Stripe redirects for per-business links, the Brainbase review URL and Slack links. If it still points at the public demo, those links go to the wrong site. |
| `PAYMENT_LINK` | Your own Stripe **test** Payment Link, or empty | The shared checkout. The default in the repository is the public demo's test link, so payments made through it land in the demo's Stripe test account, not yours. Leave it empty until step 7 if you are not using Stripe; "Claim it" then shows a "Checkout isn't wired up yet" page. |
| `CLAUDE_MODEL` | A Claude model id | Only used with an `sk-ant-` key. |
| `HQ_LAT`, `HQ_LON` | The center of the block to scout | Defaults to 101 Townsend St, San Francisco. |

Optional vars (not in `wrangler.jsonc` by default; add them under `vars` if you want them):

| Var | Default | Effect |
|---|---|---|
| `OPENAI_MODEL` | `gpt-5-mini` | OpenAI model tried first; falls back to `gpt-5-mini`, `gpt-4.1-mini`, `gpt-4o-mini`. |
| `AUTO_VIDEO` | unset | `"1"` starts a Higgsfield clip automatically after each single build (never during block runs). Without it, clips start only from the per-card button. |
| `HIGGSFIELD_MODEL` | unset | A Higgsfield endpoint id to try first, for example `kling-video/v2.5-turbo/standard/image-to-video`. |

## 5. Deploy

```bash
npx wrangler deploy        # or: npm run deploy
```

The first deploy applies the Durable Object migration `v1`, which creates the SQLite-backed `HQ` class. Nothing else needs provisioning: HQ creates its tables on first use.

Check it:

```bash
export CO=https://coldopen.<your-subdomain>.workers.dev
curl -s $CO/api/health
# {"ok":true,"businesses":0,"running":0}
curl -s $CO/api/config | jq '{llm, integrations}'
```

With no keys, `llm` is `Workers AI · Llama 3.3 70B` and only `workersAI` is `true` among the integrations.

## 6. Add secrets

Every secret is optional. Add them after the first deploy, either with the helper script or one by one.

### With the helper script

```bash
bash scripts/setup-secrets.sh
```

It asks for each secret with hidden input and pipes the value straight into `wrangler secret put`. Nothing is printed or saved. Press Enter to skip any prompt. In order: Anthropic key, OpenAI key, Stripe (see below), Slack webhook URL, Higgsfield key and secret, Brainbase key, Taste Labs key.

**Important if you are not the public demo:** the script has the public demo's URL hard-coded as `WORKER_URL`. It uses that URL for the Stripe webhook it can register and for its closing message. When deploying your own copy, either answer **n** to "Register the Stripe webhook" and register it yourself in step 7, or change `WORKER_URL` at the top of the script in your fork first.

Stripe behavior in the script: if the Stripe CLI is installed and logged in (`~/.config/stripe/config.toml` exists), it offers to copy the **test-mode** key from your default CLI profile into `STRIPE_SECRET_KEY` and to register the webhook for `checkout.session.completed`, storing its signing secret as `STRIPE_WEBHOOK_SECRET`. Without the CLI, it asks for a test secret key and does not set a webhook secret.

### One at a time

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put SLACK_WEBHOOK_URL
npx wrangler secret put HIGGSFIELD_API_KEY
npx wrangler secret put HIGGSFIELD_API_SECRET
npx wrangler secret put TASTE_API_KEY
npx wrangler secret put BRAINBASE_API_KEY
```

| Secret | Format | Unlocks |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Claude as the brain. A plain `sk-` key stored here is treated as an OpenAI key. |
| `OPENAI_API_KEY` | `sk-...` | OpenAI text and image models |
| `STRIPE_SECRET_KEY` | `sk_test_...` or `rk_test_...` | Verified payments on `/claimed`; a dedicated Payment Link per business (test keys only) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Signature-verified webhooks |
| `SLACK_WEBHOOK_URL` | `https://hooks.slack.com/services/...` | Slack mirror |
| `HIGGSFIELD_API_KEY` (+ `HIGGSFIELD_API_SECRET`) | key id and secret, or `id:secret` in the key alone | Video clips |
| `TASTE_API_KEY` | Taste Labs key | Taste Labs brand extraction |
| `BRAINBASE_API_KEY` | Brainbase key | Brainbase second opinion |

Secrets take effect without a redeploy. `GET /api/config` shows which integrations are live, and Mission Control lights a pill for each.

## 7. Stripe: checkout, verification and the webhook

Use **test mode** for anything that is a demo. Cold Open only creates per-business Payment Links with a test key; with a live key it falls back to the shared `PAYMENT_LINK`.

### 7a. The shared Payment Link

1. In the Stripe Dashboard (test mode), create a product, for example "Cold Open Launch Pack", priced at $49 one-time.
2. Create a Payment Link for it. Under **After payment**, choose to redirect customers to your website and enter:

   ```
   https://<your-worker>/claimed?session_id={CHECKOUT_SESSION_ID}
   ```

3. Put the link in `PAYMENT_LINK` in `wrangler.jsonc` and deploy again.

Cold Open appends `?client_reference_id=<business id>` to the link for each business, so every payment says which preview it was for.

### 7b. Verified payments

Set `STRIPE_SECRET_KEY` to a test secret key. Then:

- `/claimed` retrieves the Checkout Session from Stripe and marks the business paid only if Stripe says it is paid (`paymentVerified: true`).
- The Closer creates a dedicated $49 Payment Link for each business, with the `/claimed` redirect built in from `PUBLIC_URL`.

Without the key, a claim is recorded from the `co_claim` cookie that `/s/:id/claim` sets for one hour, and shown as unverified.

### 7c. The webhook

Register an endpoint so payments are recorded even if the buyer closes the tab before the redirect.

**Dashboard:** Developers → Webhooks → Add endpoint.

- URL: `https://<your-worker>/api/stripe/webhook`
- Events: `checkout.session.completed` (and `checkout.session.async_payment_succeeded` if you enable delayed payment methods)
- Copy the endpoint's signing secret and store it:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

**Stripe CLI** (test mode):

```bash
stripe webhook_endpoints create \
  --url "https://<your-worker>/api/stripe/webhook" \
  -d "enabled_events[]=checkout.session.completed"
# the JSON response contains "secret": "whsec_..." — store it with wrangler secret put
```

With the signing secret set, every webhook is checked with HMAC-SHA256 and a 5-minute replay window, and anything that fails is rejected with `400`. Without it, see [SECURITY.md](../SECURITY.md#known-limitations-by-design-in-v100) for what is and is not trusted.

### 7d. Test a payment

Open a built preview, press **Claim it · $49**, and pay with Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC. You land on `/claimed`, Mission Control shows a money toast and Revenue goes up.

## 8. Custom domain

The zone must be on your Cloudflare account. Add a route to `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "coldopen.example.com", "custom_domain": true }],
```

Then:

1. Set `PUBLIC_URL` to `https://coldopen.example.com`.
2. `npx wrangler deploy`. Cloudflare creates the DNS record and certificate for the custom domain.
3. Update the Payment Link's redirect (step 7a) and the webhook endpoint URL (step 7c) to the new host. Per-business links created before the change keep their old redirect, because HQ reuses a business's existing dedicated link on every rebuild. Edit the redirect on those links in the Stripe Dashboard if that matters.
4. Optional: add `"workers_dev": false` to stop serving the `workers.dev` hostname.

## 9. Local development

```bash
npm run dev          # wrangler dev on http://localhost:8787
npm run typecheck    # tsc --noEmit on src/, then on test/
npm test             # unit tests
```

- Put secrets in `.dev.vars` (git-ignored), one `NAME=value` per line.
- The Workers AI binding calls Cloudflare's hosted models even in local dev, so you need `wrangler login`, and usage counts against your account.
- The Durable Object and KV run locally under `.wrangler/`.
- Forward Stripe events to your dev server; the command prints a `whsec_...` secret for `.dev.vars`:

  ```bash
  stripe listen --forward-to localhost:8787/api/stripe/webhook
  ```

- To review the Mission Control UI without any backend, open `http://localhost:8787/?mock=1`. A "Mock data" badge shows whenever the in-memory mock is active.

## 10. Verify it works

1. Open your URL. The connection indicator should say **Live**.
2. Press **Scout the block** (`S`). Pins appear on the map and cards in the grid.
3. Press **Run the block** (`R`). Up to 8 of the nearest scouted businesses build, 3 at a time. Watch the agent channel.
4. Open a finished card's site. It should show the "Unofficial concept preview" banner with **Claim it** and **Remove this preview**.
5. Watch the logs while you do this:

   ```bash
   npx wrangler tail
   ```

## Costs

Cold Open is cheap to run, but not free. Check each provider's pricing page for current numbers; the figures below are either Cold Open's own measurements from the live demo or constants in the code.

**Cloudflare**

- **Workers plan.** We recommend Workers Paid (a $5 monthly minimum at the time of writing). The Free plan's limits are tight for this workload: a build makes many outbound requests (the code dispatches each block build as its own request precisely to stay under the Free plan's 50-subrequest limit), and the Free plan's Workers AI allocation runs out fast.
- **Workers AI.** Every account gets a free daily allocation of 10,000 neurons. On the Free plan, using it up returns error `4006`; Cold Open's quota breaker then skips Workers AI (text and images) until 00:00 UTC. On Workers Paid, usage beyond the allocation is billed. Llama 3.3 70B text and FLUX images both draw from it.
- **Durable Objects, KV and requests** are billed under the normal Workers pricing. A hero image is one KV object; a board is one Durable Object.

**Model providers** (only if you add keys)

- **OpenAI.** On the live demo (Sep 28, 2026; OpenAI `gpt-5-mini` for text), the CFO's estimate was about **4 to 6¢ per site**, and under **$1** for the whole board of 24 scouted and 16 built. The hero image is part of that: the code estimates FLUX.1 schnell at 0.07¢, FLUX.2 klein at 0.2¢, `gpt-image-1` at 2¢ and `dall-e-3` at 8¢ per image, and charges only the source that succeeded. Each extra taste-gate version adds one Builder and one Critic call.
- **Claude.** Priced in the code's cost table by model family (for example $2 / $10 per million input / output tokens for `sonnet-5` models). Treat the CFO's number as an estimate.
- **The CFO's spend is an estimate** computed from token counts and a price table in `src/llm.ts`. Your provider's dashboard is the source of truth.

**Other integrations** (not included in the CFO's spend)

- **Higgsfield:** each clip uses Higgsfield credits. That is why automatic clips are opt-in (`AUTO_VIDEO`) and never run during block builds.
- **Brainbase:** each second opinion is one managed-agent thread (one sandbox run) on your Brainbase credits.
- **Taste Labs:** each new website extraction uses Taste Labs credits; results are cached in KV for 7 days.
- **Stripe:** test mode is free. In live mode, Stripe's normal processing fees apply.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Scout says "Overpass didn't come through", or logs show 429/504 from the mirrors | The public Overpass mirrors shed load under demand | The Scout already hedges across three mirrors and retries once. Around 101 Townsend St it then falls back to the bundled OSM snapshot automatically. Elsewhere there is no snapshot, so wait a minute and scout again, or use a smaller radius. |
| `Scouting failed: Overpass sweep timed out after 70s` | Every mirror was slow | Same as above. |
| `409 Scout is already sweeping the block` | A sweep is in progress | Wait for it to finish. |
| `400 Nothing waiting to build — scout the block first.` | No business is in `scouted` status | Scout first, or use Build/Rebuild on a card. |
| Workers AI pill says quota exhausted; events mention `4006` or "daily free allocation" | The free daily allocation (10,000 neurons) is used up | Add an OpenAI key (text and images) or an Anthropic key (text only; images still need OpenAI), or move to Workers Paid. The breaker re-probes every 10 minutes and resets at 00:00 UTC. |
| Critic events show `provider: "heuristic"` | No model answered the rubric | Check keys and the Workers AI pill. See [TASTE-GATE.md](TASTE-GATE.md#known-limitations). |
| `Brainbase second opinion unavailable ... out of credits (HTTP 402)` | The Brainbase account has no credits | Top up at app.brainbaselabs.com, or remove the secret: `npx wrangler secret delete BRAINBASE_API_KEY`. Builds are unaffected either way. |
| `Higgsfield account is out of credits (403)` | No Higgsfield credits | Top up, or attach a video by URL from the drawer. The site is unaffected. |
| `Higgsfield rejected the API credentials (401)` | Key id without its secret | Set `HIGGSFIELD_API_SECRET`, or store `HIGGSFIELD_API_KEY` as `id:secret`. |
| After a deploy, cards show "Build interrupted by a server restart" | Deploying restarts the Durable Object, which kills in-flight builds | HQ marks them and automatically rebuilds the first six about 2 s later. Rebuild any others by hand. Do not deploy during a live demo. |
| Deploy fails on the KV namespace | `wrangler.jsonc` still has the public demo's namespace id | Create your own (step 3). |
| "Claim it" shows "Checkout isn't wired up yet" (503) | `PAYMENT_LINK` is empty and there is no per-business link | Set `PAYMENT_LINK` (step 7a) and redeploy; it applies to every business at once. Or set `STRIPE_SECRET_KEY` (test) and Rebuild, which creates a per-business link. |
| Paid in Stripe, but Mission Control shows nothing | The redirect is missing `?session_id={CHECKOUT_SESSION_ID}`, the claim cookie expired (1 hour) or was set in another browser, or the webhook points at another URL | Fix the Payment Link redirect; register the webhook for your own URL (the setup script's hard-coded URL is the public demo's); set `STRIPE_SECRET_KEY` so `/claimed` can verify. |
| Stripe shows webhook deliveries failing with 400 | Wrong `STRIPE_WEBHOOK_SECRET`, or clock skew beyond 5 minutes | Copy the signing secret of this exact endpoint again. |
| Payment shows as unverified | No `STRIPE_SECRET_KEY` and no webhook secret | Set both (step 7). |
| Pitch links, Slack links or the Brainbase review point at the wrong host | `PUBLIC_URL` is not your deployment | Fix `PUBLIC_URL` and redeploy. |
| `llm` says Workers AI although you set a key | Key prefix | Claude keys must start with `sk-ant-`; OpenAI keys with `sk-`. |
| No hero images | Every image source failed (Workers AI quota, no OpenAI key, no usable `og:image`) | Sites still ship with a typographic hero. Add an OpenAI key or wait for the Workers AI reset. |
| Mission Control stuck on "Reconnecting" | A proxy or network blocks WebSockets | The UI falls back to polling `/api/state` every 5 s, so it keeps working, just less live. |
| A Taste Labs extraction never shows up | A fresh extraction can take minutes; the Archivist waits at most about 20 s | Later builds of the same site pick up the cached result. |

## Before you run it in public

The demo API has no authentication. Anyone with the URL can scout, build, reset or remove. Before you point it at a real neighborhood, read [SECURITY.md](../SECURITY.md) and [docs/ETHICS.md](ETHICS.md). The short version:

- Put Mission Control and the operator API (`/`, `/api/*` except `/api/stripe/webhook`, and `/agents/*`) behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) or similar.
- Keep the owner-facing routes public: `/s/*`, `/claimed`, `/img/*` and `/api/stripe/webhook`.
- Set both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` before taking real money, and publish a refund policy.

## Updating and tearing down

- **Update:** `git pull`, then `npx wrangler deploy`. State in the Durable Object survives deploys; builds in flight are interrupted and resumed as described above.
- **Wipe the board** (keeps the deployment): `curl -X POST $CO/api/reset -H 'content-type: application/json' -d '{"confirm":"RESET"}'`. This deletes every business and event, including the record of owners who asked to be removed, so those businesses could be scouted again.
- **Tear down:** `npx wrangler delete` removes the Worker. Delete the KV namespace separately in the dashboard or with `npx wrangler kv namespace delete`. Both are irreversible.
