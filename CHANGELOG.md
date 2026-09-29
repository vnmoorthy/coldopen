# Changelog

All notable changes to Cold Open are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Deep documentation: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (routing, the HQ Durable Object lifecycle, SQLite schema, WebSocket protocol, pipeline stages, cost accounting, image chain, payment attribution, failure modes), [docs/AGENTS.md](docs/AGENTS.md) (one section per agent), [docs/TASTE-GATE.md](docs/TASTE-GATE.md) (the Critic's rubric, banned phrases, fact check and live results), [docs/DEPLOY.md](docs/DEPLOY.md) (step-by-step deploy on your own account) and [docs/FAQ.md](docs/FAQ.md).
- Community files: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1), [SECURITY.md](SECURITY.md), [ROADMAP.md](ROADMAP.md), GitHub issue forms and a pull request template.
- Unit tests with Vitest (`npm test`, `test/`), with every network call stubbed and fictional fixtures only; `npm run typecheck` now also checks the tests.
- GitHub Actions CI: typecheck and unit tests on every push and pull request.

- Mission Control: a light theme alongside the dark one, cycled System → Light → Dark with the header button or <kbd>T</kbd> (and `?theme=light|dark|system` for one page load), plus tab navigation on phone-width screens.

### Changed

- [CONTRIBUTING.md](CONTRIBUTING.md) rewritten: dev setup, tests, coding style, where to add an agent or integration, and a pull request checklist.
- The Brainbase second opinion's time budget (`BUDGET_MS` in `src/integrations/brainbase.ts`) is now 290 s, up from 150 s.
- **Run the block** (the button or <kbd>R</kbd>) now asks for confirmation first, because every build calls paid models.
- `package.json` gains `test` and `test:watch` scripts and Vitest 5 as a dev dependency; `typecheck` now also checks `test/`. Node 22.12 or newer is required to run the tests.
- README, docs and media: a shorter demo GIF, lighter images, a gallery of seven previews, and accuracy fixes across the API, integrations, deploy, ethics and FAQ docs.

## [1.0.0] - 2026-09-28

First release, built in one day at the Startup Speedrun Hackathon at Cloudflare HQ, 101 Townsend St, San Francisco.

### Added

**Platform**

- One Cloudflare Worker (`src/index.ts`) serving Mission Control from static assets and routing `/api/*`, `/agents/*`, `/s/*`, `/claimed` and `/img/*`.
- One Agents SDK Durable Object, `HQ` (instance `main`), holding all state in SQLite (`co_businesses`, `co_events`), serving the JSON API and broadcasting every change over WebSocket (`snapshot`, `event`, `business`, `stats`, `removed`, plus `ping`/`pong`).
- Self-healing restarts: builds interrupted by a Durable Object restart are marked and the first six are resumed automatically through a durable schedule.
- Board epochs so a reset cleanly aborts in-flight work, and per-run tokens so a removal aborts a running build.
- Block runs with a concurrency of 3, each build dispatched as its own request to stay within per-invocation subrequest limits.
- KV namespace `MEDIA` for hero images, served from `/img/:key` with a one-day cache.

**Agents**

- **Scout:** OpenStreetMap Overpass sweeps hedged across three public mirrors, a bundled OSM snapshot of the block (87 elements within 600 m of 101 Townsend St) as a fallback, chain filtering by brand tags and 127 known chain names, and name lookup through Nominatim then Overpass.
- **Archivist:** reads the business's own homepage (title, meta, `og:image`, `theme-color`, CSS color frequency, Google Fonts, headings, visible text, prices) and produces a `Brand` with provenance (`sourceSignals`), contrast-checked palettes, allowlisted fonts, offerings verified against the page, and a story grounded in the evidence.
- **Builder:** composes a `SiteSpec` in one of three themes (editorial, bold, warm), with hours humanized from OSM, safe calls to action, no prices on unconfirmed menus, and a deterministic fallback draft.
- **Critic:** a 14-check weighted rubric (brand fidelity 30, specificity 25, clarity 20, voice 15, CTA 10), a deterministic penalty for 56 banned phrases, structural checks and an unsupported-claims fact check. Drafts under 85 are revised, up to three versions, and the best version ships.
- **Director:** hero images through Workers AI FLUX.1 schnell and FLUX.2 klein, OpenAI `gpt-image-1` and `dall-e-3`, then the business's own `og:image` re-hosted, then a typographic hero. Optional Higgsfield image-to-video clips, polled on a schedule. Clips start on demand from the drawer; automatic clips after a single build are opt-in with the var `AUTO_VIDEO="1"`, and block runs never start clips.
- **Closer:** an honest pitch in which the model writes only the subject and one sentence; checkout links tagged with `client_reference_id`, or a dedicated $49 Payment Link per business with a Stripe test key. Nothing is sent automatically.
- **CFO:** estimated model spend per business and per block against revenue, in the agent channel and the stats ribbon.

**LLM chain**

- `llmJSON()`: Claude (with an `sk-ant-` key), then OpenAI (`gpt-5-mini` by default, with `gpt-4.1-mini` and `gpt-4o-mini` fallbacks), then Workers AI Llama 3.3 70B and gpt-oss-120b. Loose JSON parsing with repair and a retry nudge, per-call cost estimates, and key routing by prefix.
- A Workers AI quota circuit breaker for error 4006 (daily allocation used up), reported in `/api/config`.

**Payments**

- Stripe webhook verification with WebCrypto HMAC-SHA256, a 5-minute tolerance and constant-time comparison; no SDK.
- Checkout Session verification on `/claimed`, with a one-hour claim cookie as the fallback, and idempotent `markPaid`.

**Integrations** (all optional, all fail soft)

- OpenAI text and images, Slack incoming-webhook mirror, Higgsfield video, Taste Labs brand extraction, and a Brainbase Labs managed-agent second opinion (`POST /v2/threads`, harness `claude_code`) posted to the agent channel after each build.

**Generated previews**

- Three themes, each with a sticky "Unofficial concept preview" banner, **Claim it · $49** and **Remove this preview**, `noindex,nofollow`, AI-image captions, a provenance panel, an OSM map with attribution, and two-click owner removal (one button, one confirmation) that purges images.

**Mission Control**

- Live map, business cards with taste rings, the agent channel, a stats ribbon, a detail drawer with score history and the pitch, keyboard shortcuts, a responsive layout down to 375 px, and a **Live challenge** mode with a speedrun split timer and QR code.
- A `?mock=1` design-review mode with an in-memory mock backend and a visible "Mock data" badge.

**Docs**

- README, SPEC, API reference, integrations guide, ethics policy and contributing guide.

### Live demo results (Sep 28, 2026)

- 24 businesses scouted and 16 sites built, for under $1 of estimated model spend (about 4 to 6¢ per site, about a minute per build on average).
- Fastest build: Game Post in 38.5 s, 96 on the first pass.
- Taste-gate loops included Arsicault Bakery 49 → 68 → 96 and Momo's 64 → 96. Full table in [docs/TASTE-GATE.md](docs/TASTE-GATE.md#live-results-sep-28-2026).
- Revenue: $0. Checkout runs in Stripe test mode.

[Unreleased]: https://github.com/vnmoorthy/coldopen/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/vnmoorthy/coldopen/releases/tag/v1.0.0
