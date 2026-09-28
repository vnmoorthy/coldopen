# Contributing to Cold Open

Thanks for helping. Cold Open is small on purpose: one Worker, one Durable Object, a handful of TypeScript modules and a static frontend with no build step. This guide covers how to run it, the rules every change has to keep, and how to add an agent.

Please read [docs/ETHICS.md](docs/ETHICS.md) before touching anything that affects generated sites, scouting or outreach. Those rules are not negotiable in review.

## Run it locally

```bash
git clone https://github.com/vnmoorthy/coldopen.git
cd coldopen
npm i
npx wrangler login          # Workers AI runs on Cloudflare even in local dev
npm run dev                 # wrangler dev on http://localhost:8787
npm run typecheck           # tsc --noEmit
```

Optional secrets go in `.dev.vars`, one `NAME=value` per line. The file is git-ignored; never commit it.

```
ANTHROPIC_API_KEY=...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

To test payments locally, forward Stripe events to your dev server:

```bash
stripe listen --forward-to localhost:8787/api/stripe/webhook
```

Use Stripe's test card `4242 4242 4242 4242`. Never use a live key in development.

## The hard rules

Every pull request must keep all of these true. Reviewers will check.

1. **No dead buttons.** Every control in Mission Control and on preview sites calls a real endpoint and does what its label says. If a feature needs a key that is not set, the button explains that instead of pretending.
2. **No fabricated data.** No fake businesses, users, stars, metrics, reviews, testimonials, ratings, awards or prices, anywhere: UI, seed data, screenshots, docs or tests that could be mistaken for real results. Illustrative examples must say they are illustrative.
3. **Graceful degradation.** The full loop must work with only Workers AI, KV and the Durable Object. Every optional integration fails soft: log, emit a `warn` event, carry on.
4. **The preview contract.** Every generated page keeps the sticky "Unofficial concept preview" banner with Claim and Remove, and `noindex,nofollow`. No theme may hide it.
5. **Workers runtime only.** TypeScript on the Cloudflare Workers runtime. Node APIs only through `nodejs_compat`.
6. **No new npm dependencies** beyond `agents` (and dev tooling). Stripe, Slack, Higgsfield and Taste Labs are called with `fetch`. If you believe a dependency is worth it, open an issue first.
7. **No build step for the frontend.** `public/` is vanilla ES modules. CDN use is limited to Leaflet and Google Fonts.
8. **Shared types are a contract.** Changing a shape in `src/types.ts` means updating `SPEC.md`, the README data model and `docs/API.md` in the same pull request.

## Project layout

```
src/index.ts            Worker router
src/hq.ts               HQ agent (Durable Object): state, events, pipeline, broadcast
src/llm.ts              llmJSON(): Claude, then Workers AI Llama 3.3, then gpt-oss-120b
src/pipeline/*.ts       one module per agent
src/integrations/*.ts   Stripe, Slack, Higgsfield, Taste Labs
src/site/render.ts      preview site, claimed, removed and not-found pages
public/                 Mission Control
docs/                   architecture, API, ethics, images
```

`docs/architecture.svg` is hand-authored; if you change the system's shape, update the diagram. `docs/hero.png` is rendered from `docs/hero.html` with headless Chrome (the command is in the file's header comment).

## Adding an agent

1. **Name and persona.** Add the name to `AgentName` in `src/types.ts`. Give it a color and a two-letter monogram in Mission Control. No emoji.
2. **Module.** Create `src/pipeline/<agent>.ts` exporting one async function that takes `(env, biz, ...)` and returns plain data. Keep it pure where you can: no direct state writes, no broadcasting. HQ does that.
3. **Model calls.** Use `llmJSON()` from `src/llm.ts` so provider fallback and cost accounting work automatically. Never call a model API directly from an agent.
4. **Wire it into HQ.** In `runPipeline(id)`, set a status if the stage needs one, emit `AgentEvent`s with `bizId`, broadcast the updated `Business`, record the stage's time in `biz.timings`, and add its cost to `biz.costCents`.
5. **Fail soft.** Catch errors, emit an `error` or `warn` event, and decide explicitly whether the business goes to `error` or the pipeline continues. The Durable Object must never crash.
6. **Document it.** Add a row to the agents table in the README and update `SPEC.md`.

## Adding an integration

- Put it in `src/integrations/<name>.ts` with an `<name>Enabled(env)` check.
- Read the provider's current API documentation and cite the endpoints you use in a comment at the top of the file.
- Bound every call with a timeout (`AbortSignal.timeout`). Never log keys.
- Add the secret to `Env` in `src/types.ts`, to `scripts/setup-secrets.sh`, to `/api/config`'s `integrations` map, and to the README's graceful degradation and configuration tables.

## Pull requests

- Keep them focused. One change per pull request is easier to review and to revert.
- Run `npm run typecheck` before pushing.
- Describe what you changed and how you verified it. For UI changes, include a screenshot or a short screen recording from a real run.
- If you touched generated sites, include a screenshot of a preview showing the banner.
- Be kind in review. Everyone here is trying to make something good.

## Reporting bugs and requesting features

Use the issue templates: [bug report](.github/ISSUE_TEMPLATE/bug_report.md) or [feature request](.github/ISSUE_TEMPLATE/feature_request.md). For a preview that says something untrue about a real business, remove it first, then open a bug so we can fix the cause.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
