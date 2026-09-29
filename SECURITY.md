# Security policy

Cold Open builds public web pages about real businesses and touches payments, so we take reports seriously. Thank you for helping.

## Supported versions

| Version | Supported |
|---|---|
| `main` branch | Yes |
| 1.0.x | Yes |

1.0.0 is the first release.

The public demo at <https://coldopen.vnarasingamoorthy.workers.dev> runs the `main` branch.

## Reporting a vulnerability

**Please report privately. Do not open a public issue with details.**

1. Go to the repository's **Security** tab and choose **Report a vulnerability**, or open <https://github.com/vnmoorthy/coldopen/security/advisories/new>. This creates a private GitHub Security Advisory that only you and the maintainers can see.
2. If that button is not available, open a public issue titled "Security contact request" with **no details**, and a maintainer will set up a private channel with you.

Please include:

- what an attacker can do, and against which component (Worker routes, HQ API, WebSocket, generated previews, Stripe flow, an integration);
- steps to reproduce, ideally against your own deployment or `wrangler dev`;
- the commit or version you tested;
- any suggested fix.

This is a small open-source project maintained on a best-effort basis. We will acknowledge your report as soon as we can, keep you updated while we work on it, and credit you in the advisory and the changelog unless you prefer otherwise.

### Testing against the public demo

The public demo is a live hackathon deployment with no authentication (see below). Please do **not**:

- reset the board, remove previews you do not own, or mass-create builds;
- send forged or replayed Stripe webhooks;
- load-test, fuzz at volume, or try to exhaust its model or Workers AI budget;
- enter real card details anywhere. Checkout is in Stripe test mode; use Stripe's test cards.

Reproduce against your own deployment ([docs/DEPLOY.md](docs/DEPLOY.md)) or `npm run dev` instead.

## Known limitations (by design in v1.0.0)

These are documented trade-offs of a public demo, not secrets. Reports that show a way around the mitigations listed here are very welcome.

| Area | Behavior | Mitigation for real deployments |
|---|---|---|
| **No authentication** | Anyone who can reach the Worker can use every operator action: scout, build (which spends the operator's model budget), run a block, reset the board, remove any preview, mark outreach status, attach video URLs. The WebSocket streams all events to anyone. | Put Mission Control, `/api/*` (except `/api/stripe/webhook`) and `/agents/*` behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) or similar, and add rate limiting. Keep `/s/*`, `/claimed`, `/img/*` and the webhook public. |
| **Public removal** | Anyone with a preview link can remove it. | Intentional: an owner must never have to prove anything to take a preview down. |
| **Unverified claims** | Without Stripe verification, `/claimed` records a claim from the `co_claim` cookie that `/s/:id/claim` sets. Visiting those two URLs in order records an unverified claim without paying. Unverified claims are stored with `paymentVerified: false` and are labeled as unverified, but they still count toward the `paid` and `revenueCents` stats. | Set `STRIPE_SECRET_KEY` so real sessions are verified, and treat only `paymentVerified: true` as revenue. |
| **Webhooks without a signing secret** | Without `STRIPE_WEBHOOK_SECRET`, HQ cannot check signatures. If `STRIPE_SECRET_KEY` is set, it re-fetches the Checkout Session from Stripe and only trusts what Stripe returns. With neither secret, a forged `checkout.session.completed` event is recorded as an **unverified** payment. | Set both Stripe secrets before taking real money. |
| **Server-side fetches of user-supplied URLs** | `POST /api/businesses` accepts any `http(s)` website. The Archivist fetches that homepage (8 s, 700 KB cap), at most one stylesheet (4 s, 200 KB) and possibly the page's `og:image` (8 s, 8 MB cap, must be JPEG/PNG/WebP). | Authentication on the API (above). |
| **`/img/:key` reads any key in the `MEDIA` namespace** | Besides hero images (`img:*`), the namespace holds Taste Labs cache entries (`taste:*`), which contain public brand data only. They are served as `application/octet-stream` with `nosniff`. | Restrict the route to the `img:` prefix (a small change in `src/index.ts`). |
| **No `robots.txt` check** | The Archivist does not consult `robots.txt` yet (see [docs/FAQ.md](docs/FAQ.md#do-you-respect-robotstxt)). | On the roadmap. |

## How the code protects itself

- **Internal routes.** The Worker talks to the HQ Durable Object's `/api/_internal/*` routes with the header `x-coldopen-internal: 1`, and strips that header from every public request before forwarding `/api/*` and `/agents/*`. HQ answers `404` to internal paths without it.
- **Output escaping.** Every value interpolated into generated HTML goes through `esc()` in `src/site/render.ts`. Colors are validated as hex, font names are reduced to letters, digits and spaces, links must be `http(s)`, and media sources must be same-origin absolute paths or `https` URLs. Untrusted text has control and bidi characters stripped.
- **Response headers.** Preview and utility pages are sent with `x-robots-tag: noindex, nofollow`, `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin` and `cache-control: no-store`.
- **Stripe webhooks.** With `STRIPE_WEBHOOK_SECRET`, `verifyWebhook()` recomputes HMAC-SHA256 over `"{timestamp}.{raw body}"` with WebCrypto, rejects timestamps more than 300 s old or in the future, and compares every `v1` signature in constant time. Invalid events get `400` and change nothing.
- **Payment verification.** With `STRIPE_SECRET_KEY`, `/claimed` retrieves the Checkout Session from Stripe and marks a business paid as verified only when Stripe reports `paid` (or `no_payment_required`). `markPaid` is idempotent.
- **Test-mode guard.** Per-business Payment Links are only created when the Stripe key is a test key (`sk_test_` or `rk_test_`).
- **Claim cookie.** `co_claim` holds only a business id, lasts one hour, and is `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Bounded calls.** Every outbound request has a timeout (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#12-timeouts-and-limits-at-a-glance)); response bodies from business websites are size-capped.
- **Integrations fail closed and quiet.** Stripe, Slack, Taste Labs, Brainbase and Higgsfield errors are logged without credentials and never crash the Durable Object.

## Handling secrets

- **Where secrets live.** Only as Worker secrets (`npx wrangler secret put NAME`, or `scripts/setup-secrets.sh`). Never put a key in `wrangler.jsonc` `vars`: that file is committed and its values are public.
- **Local development.** Use `.dev.vars`, which is git-ignored. Never commit it, and never paste its contents into an issue, a pull request, a screenshot or a log.
- **The setup script** reads each value with hidden input and pipes it straight into `wrangler secret put`. Nothing is echoed, logged or written to disk.
- **What the app exposes.** `GET /api/config` returns booleans, labels and public values only (for example the public Payment Link URL and the Stripe mode `test`/`live`), never a key.
- **Logs.** Stripe error messages are scrubbed of anything that looks like a key or webhook secret before they are logged or shown. The Slack webhook URL, Taste Labs key, Brainbase key and Higgsfield credentials are never logged. Higgsfield uploads use a presigned URL that carries no credentials.
- **Key routing.** Keys are routed by prefix: only `sk-ant-` keys are sent to Anthropic. A plain `sk-` key stored in `ANTHROPIC_API_KEY` is sent to OpenAI, never to Anthropic.
- **Least privilege.** For Stripe, prefer a restricted test key (`rk_test_`) with only what Cold Open uses: read Checkout Sessions, write Prices and Payment Links. Use test mode for every demo.
- **If a key leaks.** Revoke it in the provider's dashboard first, then store a new one with `npx wrangler secret put`. Secrets take effect without a redeploy. For a leaked `STRIPE_WEBHOOK_SECRET`, roll the endpoint's signing secret in Stripe and update the Worker secret.
- **In reports.** Issue forms remind you to remove keys, webhook secrets and personal contact details. If you accidentally post one, delete the comment, rotate the key, and tell us so we can scrub history.

## Out of scope

- Findings that require an already-compromised Cloudflare, Stripe or model-provider account.
- Missing authentication on the demo's operator API, public preview removal, and unverified claims or webhooks without Stripe secrets, as documented above (unless you find a way around the documented mitigations).
- Rate limits and quotas of third-party services (Overpass, Nominatim, Workers AI, OpenAI, Higgsfield, Taste Labs, Brainbase).
- Content accuracy of a specific generated preview. Please use **Remove this preview** and open a normal bug report instead.
