## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Closes #123". -->

## How I verified it

<!--
Commands you ran and what you saw. For behavior changes, describe a real run
(npm run dev or your own deployment). For UI changes, add a screenshot or a short
recording. If you touched generated sites, include a screenshot that shows the preview banner.
-->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Tried it in `npm run dev` or on my own deployment (say which, above)

## Cold Open's hard rules

- [ ] **No dead buttons.** Every control I added calls a real endpoint and does what its label says, or explains which key it needs.
- [ ] **No fabricated data.** No fake businesses, users, stars, metrics, reviews, ratings, prices or results in code, UI, docs, screenshots or tests. Fixtures are clearly fictional.
- [ ] **Graceful degradation.** Works with only Workers AI, KV and the Durable Object. Optional integrations fail soft (log, `warn` event, carry on) and never crash HQ.
- [ ] **The preview contract.** Every generated page keeps the sticky "Unofficial concept preview" banner with Claim and Remove, and `noindex,nofollow`.
- [ ] **Honest agents.** Model calls go through `llmJSON()`. Any new rule that matters is enforced in code, not only in a prompt.
- [ ] **No new npm dependencies** (or the issue explains why one is worth it).
- [ ] **Bounded and safe.** Every outbound call has a timeout. No secret is logged, returned by the API or committed.

## Docs

- [ ] Changed a shape in `src/types.ts`: updated `SPEC.md`, the README data model and `docs/API.md`.
- [ ] Changed a pipeline stage, constant, timeout or failure behavior: updated `docs/ARCHITECTURE.md`, `docs/AGENTS.md` or `docs/TASTE-GATE.md`.
- [ ] Added a secret or integration: updated `Env`, `/api/config`, `scripts/setup-secrets.sh`, `docs/INTEGRATIONS.md` and the README tables.
- [ ] Added an entry under `[Unreleased]` in `CHANGELOG.md`.
- [ ] Not applicable: this change needs no doc updates.

## Notes for reviewers

<!-- Anything risky, anything you are unsure about, follow-ups you left out on purpose. Remember that deploying restarts the HQ Durable Object and interrupts builds in flight. -->
