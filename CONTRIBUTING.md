# Contributing to Cold Open

Thanks for helping. Cold Open is small on purpose: one Worker, one Durable Object, a handful of TypeScript modules and a static frontend with no build step. This guide covers how to run it, how to test it, the rules every change has to keep, and where new agents and integrations go.

Before you start:

- Read [docs/ETHICS.md](docs/ETHICS.md) before touching anything that affects generated sites, scouting or outreach. Those rules are not negotiable in review.
- Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security issues go through [SECURITY.md](SECURITY.md), not public issues.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/AGENTS.md](docs/AGENTS.md) explain how the pieces fit. Reading them first will save you time.

## Contents

- [Set up a dev environment](#set-up-a-dev-environment)
- [Tests and typecheck](#tests-and-typecheck)
- [The hard rules](#the-hard-rules)
- [Coding style](#coding-style)
- [Project layout](#project-layout)
- [Adding an agent](#adding-an-agent)
- [Adding an integration](#adding-an-integration)
- [Keeping the docs true](#keeping-the-docs-true)
- [Pull request checklist](#pull-request-checklist)
- [Issues and discussions](#issues-and-discussions)

## Set up a dev environment

You need Node.js 22.12 or newer (the version CI uses; Vitest 5 requires it), npm and a Cloudflare account.

```bash
git clone https://github.com/vnmoorthy/coldopen.git
cd coldopen
npm install
npx wrangler login     # Workers AI runs on Cloudflare even in local dev
npm run dev            # wrangler dev on http://localhost:8787
```

`wrangler dev` runs the Worker, the HQ Durable Object and KV locally (state lives under `.wrangler/`). The Workers AI binding always calls Cloudflare's hosted models, so local builds use your account's allocation.

**Secrets.** Every secret is optional. For local development put them in `.dev.vars`, one `NAME=value` per line. The file is git-ignored; never commit it and never paste it anywhere.

```
OPENAI_API_KEY=sk-...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

**Payments locally.** Forward Stripe test events to your dev server; the command prints the `whsec_...` value for `.dev.vars`:

```bash
stripe listen --forward-to localhost:8787/api/stripe/webhook
```

Use the test card `4242 4242 4242 4242`. Never use a live key in development.

**UI without a backend.** Open `http://localhost:8787/?mock=1` to run Mission Control against the in-memory mock in `public/mock.js`. A "Mock data" badge stays on screen while it is active. Use it for design review only.

**Your own deployment.** [docs/DEPLOY.md](docs/DEPLOY.md) walks through deploying to your account. Please do not deploy to, reset or stress the public demo.

## Tests and typecheck

```bash
npm run typecheck     # tsc --noEmit for src/, then for test/
npm test              # Vitest, once
npm run test:watch    # Vitest in watch mode
```

CI (`.github/workflows/ci.yml`) runs both on every push and pull request. They must pass before review.

- Tests live in `test/*.test.ts` and run in plain Node (`vitest.config.ts`). No secrets are needed.
- **Every network call is stubbed.** Use `stubFetch()` from `test/fixtures.ts`; a test that reaches the real internet is a bug.
- **Fixtures are fictional.** `makeEnv()`, `makeBiz()`, `makeBrand()` and `makeSpec()` build made-up businesses ("Harbor Lane Coffee" on "Example Street"). Never put a real business, a real review or a real score in a test.
- `makeEnv()` has no API keys, so code under test takes its deterministic fallback path. That is also the zero-key path users rely on, so it deserves tests.
- Good candidates for new tests are pure functions: `parseJsonLoose`, `humanizeHours`, `slopHits`/`scrubSlop`, `unsupportedClaims`, `finalizePalette` rules (module-private in `src/pipeline/brand.ts`; export it, or test it through `extractBrand`), `verifyWebhook`, `withClientReference`, and the renderer's escaping.

## The hard rules

Every pull request must keep all of these true. Reviewers will check.

1. **No dead buttons.** Every control in Mission Control and on preview sites calls a real endpoint and does what its label says. If a feature needs a key that is not set, the button explains that instead of pretending.
2. **No fabricated data.** No fake businesses, users, stars, metrics, reviews, testimonials, ratings, awards or prices, anywhere: UI, seed data, screenshots, docs or tests that could be mistaken for real results. Illustrative examples must say they are illustrative.
3. **Graceful degradation.** The full loop must work with only Workers AI, KV and the Durable Object. Every optional integration fails soft: log, emit a `warn` event, carry on.
4. **The preview contract.** Every generated page keeps the sticky "Unofficial concept preview" banner with Claim and Remove, and `noindex,nofollow`. No theme may hide, shrink or move it.
5. **Rules live in code, not only in prompts.** If a model must never do something (invent a price, promise delivery), there is a deterministic check that enforces it on every output. Prompts are the first line; code is the guarantee.
6. **Workers runtime only.** TypeScript on the Cloudflare Workers runtime. Node APIs only through `nodejs_compat`.
7. **No new npm dependencies** beyond `agents` and dev tooling. Stripe, Slack, OpenAI, Higgsfield, Taste Labs and Brainbase are called with `fetch`. If you believe a dependency is worth it, open an issue first.
8. **No build step for the frontend.** `public/` is vanilla ES modules. External services in `public/` are limited to Leaflet (unpkg), Google Fonts, Esri basemap tiles and api.qrserver.com for QR codes.
9. **Shared types are a contract.** Changing a shape in `src/types.ts` means updating `SPEC.md`, the README data model and `docs/API.md` in the same pull request.

## Coding style

There is no formatter in the repository. Match the code around you:

- TypeScript `strict`, ES modules, 2-space indentation, semicolons. Double quotes in `src/` and `test/`, single quotes in `public/`.
- Small named helpers over clever one-liners. Comments explain **why** (a platform limit, a provider quirk, an honesty rule), not what the next line does.
- **Never throw out of an integration.** Integration functions return `null` or a typed error result and log without secrets. Only the pipeline decides whether something is fatal.
- **Bound every outbound call** with `AbortSignal.timeout(...)` or `withTimeout(...)`, and cap response sizes when reading third-party HTML.
- **Inside HQ, never hold a `Business` across an `await` and write it back.** Use `this.update(id, (b) => ({ ... }))` so the change merges onto the latest copy, and call `check()` after every awaited stage so removals and resets abort cleanly.
- **Escape everything** that goes into HTML with `esc()` in `src/site/render.ts`, and validate colors, fonts and URLs before use.
- **User-facing text** is plain, specific and honest: full sentences, no hype, no exclamation marks, no emoji. Agent-channel messages say what happened and what to do next.
- Keep secrets out of logs, events, URLs and error messages.

## Project layout

```
src/index.ts                 Worker router: /api, /agents, /s/:id, /claimed, /img/:key, static assets
src/hq.ts                    HQ Durable Object: state, API routes, pipeline orchestration, WebSocket broadcast
src/llm.ts                   llmJSON(): Claude -> OpenAI -> Workers AI, JSON repair, cost estimates, quota breaker
src/types.ts                 shared types (Business, Brand, SiteSpec, ScoreVersion, AgentEvent, Stats, Env)
src/pipeline/scout.ts        Scout: Overpass (hedged mirrors), Nominatim, chain filter, OSM snapshot fallback
src/pipeline/brand.ts        Archivist: website reading, brand synthesis and validation, shared place helpers
src/pipeline/builder.ts      Builder: SiteSpec composition and revision
src/pipeline/critic.ts       Critic: rubric, banned phrases, structural checks, fact check
src/pipeline/director.ts     Director: hero prompt and image chain
src/pipeline/closer.ts       Closer: checkout link and pitch draft
src/integrations/*.ts        openai, stripe, slack, higgsfield, taste, brainbase
src/site/render.ts           preview sites (three themes) and the claimed, remove, removed and 404 pages
public/                      Mission Control (index.html, app.js, styles.css, mock.js)
test/                        Vitest unit tests and fictional fixtures
scripts/setup-secrets.sh     interactive secret setup, piped into wrangler
docs/                        architecture, agents, taste gate, deploy, API, integrations, ethics, FAQ
```

## Adding an agent

1. **Name and persona.** Add the name to `AgentName` in `src/types.ts`. Give it a two-letter monogram, a color and a role in the `AGENTS` map at the top of `public/app.js`. No emoji.
2. **Module.** Create `src/pipeline/<agent>.ts` exporting one async function that takes `(env, biz, ...)` and returns plain data plus `costCents`. No state writes, no broadcasting: HQ does that.
3. **Model calls.** Use `llmJSON()` from `src/llm.ts`, so provider fallback, JSON repair and cost estimates work automatically. Never call a model API directly from an agent. Give it a deterministic fallback for when every provider fails.
4. **Guardrails in code.** Validate the model's output with plain code: allowlists, regexes, evidence checks. See the existing agents in [docs/AGENTS.md](docs/AGENTS.md) for the pattern.
5. **Wire it into HQ.** In `src/hq.ts`, add it to the `Stage` type, `STAGE_TIMEOUT_MS` and `STAGE_AGENT`, then call it from `runPipeline()`: wrap it in `withTimeout`, call `check()` right after, add its cost with `stageCost()`, record `timings`, and emit `start` and `done` events with `bizId` and `data.stage`. If it needs its own status, add it to `BizStatus`, to `TRANSIENT` in `hq.ts` (so restarts recover it), to `STATUS_WORDS` in `src/index.ts` and to `STAGE_LABEL` in `render.ts`.
6. **Decide whether failure is fatal.** Either let errors propagate (the business goes to `error`) or catch them, emit a `warn` and continue, as the Director does. Write the decision down in a comment.
7. **Live challenge.** If the agent should get its own split in the speedrun timer, add it to `SPLITS` in `public/app.js`.
8. **Test and document it.** Add a test with stubbed fetch, a section in `docs/AGENTS.md`, a row in the README's agents table, and the stage in `docs/ARCHITECTURE.md` and `SPEC.md`.

## Adding an integration

1. Put it in `src/integrations/<name>.ts` with a `<name>Enabled(env)` check.
2. Read the provider's current API documentation and cite the endpoints you use, and the date you checked, in a comment at the top of the file. Mark anything you had to guess as an assumption.
3. Bound every call with a timeout. Never log keys. Never throw to the caller: return `null` (or a typed error) and let HQ emit a `warn`.
4. If it costs money per call, report `costCents` so the CFO can count it, or document that it is not counted.
5. Add the secret to `Env` in `src/types.ts`, to `integrations()` (and `/api/config`) in `src/hq.ts`, to `scripts/setup-secrets.sh`, and to the tables in the README, `docs/INTEGRATIONS.md` and `docs/DEPLOY.md`.
6. Add tests with `stubFetch()` covering success, a 4xx, a 5xx and a timeout.

## Keeping the docs true

Docs in this repository describe the code as it is. If your change makes a sentence false, fix the sentence in the same pull request.

| If you change | Update |
|---|---|
| A type in `src/types.ts` | `SPEC.md`, README data model, `docs/API.md` |
| An API route or response | `docs/API.md`, README API table |
| A pipeline stage, timeout, limit or failure behavior | `docs/ARCHITECTURE.md`, `docs/AGENTS.md` |
| The Critic, the rubric, `TASTE_BAR` or `MAX_VERSIONS` | `docs/TASTE-GATE.md` |
| A secret, var or integration | `docs/INTEGRATIONS.md`, `docs/DEPLOY.md`, README configuration tables |
| Anything user-visible | `CHANGELOG.md` under `[Unreleased]` |

Numbers in docs must come from the code or from a real, dated run. Do not add benchmarks, star counts, user counts or testimonials.

`docs/architecture.svg` is hand-authored; if you change the system's shape, update it. `docs/hero.png` (1280x640, used as the repository's social preview image) is rendered from `docs/hero.html` with headless Chrome (the command is in that file's header comment). Mermaid diagrams in the docs must render on GitHub; preview them before you push.

## Pull request checklist

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) repeats this list.

- [ ] One focused change per pull request.
- [ ] `npm run typecheck` and `npm test` pass.
- [ ] Verified in `npm run dev` or on your own deployment, and described how in the pull request.
- [ ] Screenshots or a short recording for UI changes; a screenshot showing the preview banner if you touched generated sites.
- [ ] The hard rules above still hold.
- [ ] Docs and `CHANGELOG.md` updated.
- [ ] No secrets, `.dev.vars` contents or personal data in the diff, screenshots or logs.

Deploying restarts the HQ Durable Object, which interrupts builds in flight (they resume automatically, the first six at least). Maintainers avoid deploying during live demos.

Be kind in review. Everyone here is trying to make something good.

## Issues and discussions

- **Bugs:** [open a bug report](https://github.com/vnmoorthy/coldopen/issues/new?template=bug_report.yml).
- **Ideas:** [request a feature](https://github.com/vnmoorthy/coldopen/issues/new?template=feature_request.yml), after checking [ROADMAP.md](ROADMAP.md).
- **Questions:** [Discussions](https://github.com/vnmoorthy/coldopen/discussions).
- **A preview says something untrue about a real business:** press **Remove this preview** on it first, then open a bug so we can fix the cause.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
