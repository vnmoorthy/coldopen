# Roadmap

Cold Open 1.0.0 was built in one day. This is what we would do next, in rough order, and why. Nothing below exists yet unless it is marked done. Dates are deliberately absent: this is a small open-source project, and we would rather be late than wrong.

Want to pick something up? Open an issue for the item (or comment on it if one exists) so work does not collide, then see [CONTRIBUTING.md](CONTRIBUTING.md).

## Near: fix what we know is wrong

Small, well-understood changes. Most are one file.

- [ ] **Show the shipped score on previews.** The "How this preview was made" panel in `src/site/render.ts` prints the last score and the word "Cleared" even when an earlier version shipped or the best score missed the bar. It should use the shipped version's score and say "flagged" when it is under the bar. ([TASTE-GATE.md](docs/TASTE-GATE.md#known-limitations))
- [ ] **Honor `robots.txt`.** Check it in `readWebsite()` and fall back to OSM facts when the homepage is disallowed. It is already a project rule in [docs/ETHICS.md](docs/ETHICS.md); the code should enforce it.
- [ ] **Separate verified from unverified revenue.** Unverified claims (cookie fallback, unsigned webhooks) currently count toward `paid` and `revenueCents`. Stats should report them apart. ([SECURITY.md](SECURITY.md#known-limitations-by-design-in-v100))
- [ ] **Serve only `img:` keys from `/img/:key`.** Today the route can also read the Taste Labs cache entries in the same KV namespace. One line in `src/index.ts`. ([SECURITY.md](SECURITY.md#known-limitations-by-design-in-v100))
- [ ] **Make the block configurable, not just the coordinates.** "SoMa", "San Francisco", "Oracle Park", "101 Townsend St" and the Critic's location words are hard-coded in several modules. Move them into config next to `HQ_LAT`/`HQ_LON`. ([FAQ.md](docs/FAQ.md#can-i-run-it-for-a-different-city))
- [ ] **A friendlier `setup-secrets.sh`.** Derive the webhook URL from `PUBLIC_URL` instead of the public demo's hard-coded URL, ask for `STRIPE_WEBHOOK_SECRET` when the Stripe CLI is absent, and subscribe to `checkout.session.async_payment_succeeded` too.
- [ ] **An explicit sensitive-category block** in the Scout (medical, legal, financial, religious, political, children), matching the rule in [docs/ETHICS.md](docs/ETHICS.md).
- [ ] **Keep the removal list across resets.** `POST /api/reset` currently deletes the record of owners who asked to be removed.
- [x] Unit tests and CI (typecheck and Vitest on every push and pull request).

## Next: make it trustworthy for real use

- [ ] **Operator authentication.** A documented Cloudflare Access setup, or a built-in operator token, so Mission Control and the operator API are private while previews, `/claimed` and the webhook stay public. Plus rate limits on builds.
- [ ] **Store the Brainbase second opinion** on the business (verdict, score, thread id) and show it in the drawer next to the Critic's history, instead of only in the event log.
- [ ] **Taste Labs brand-adherence as a background score.** `tasteStartAdherence()` and `tasteGetAdherence()` already exist in `src/integrations/taste.ts`; wire them in after a site is ready, following the Brainbase pattern (never blocking the build).
- [ ] **Custom domains through Cloudflare Registrar**, so a claim can end with the site on the owner's own domain.
- [ ] **An owner-side editor** for claimed sites: fix hours, swap an offering, replace the hero image, without waiting for us.
- [ ] **Automated handover** after payment: remove the preview banner, export the site files, connect the domain.
- [ ] **Agent evals.** A fixed set of fictional businesses with expected properties (no invented claims, correct hours, legible palettes) run against the Archivist, Builder and Critic on every change, potentially managed with Brainbase.

## Later: grow carefully

- [ ] **Multi-city.** Named blocks with their own coordinates, labels and neighborhood names, and a map that zooms out across them.
- [ ] **Real email outreach** through Cloudflare Email Service, only with suppression lists, a working unsubscribe, a physical postal address, one message per business, and CAN-SPAM compliance at minimum ([docs/ETHICS.md](docs/ETHICS.md#rules-for-outreach)). A person still approves every send.
- [ ] **Stripe Connect payouts** for partner designers and local agencies who run their own Cold Open block.
- [ ] **Multi-tenant boards:** one Durable Object per board instead of one per deployment.
- [ ] **Outreach rules beyond the U.S.**, with consent-based sending where the law requires it.

## Not planned

Some things would make Cold Open bigger and worse. We will not build them:

- Sending cold email without a person approving it.
- Generated reviews, ratings, testimonials, follower counts or "as seen in" logos, even as placeholders.
- Letting previews be indexed by search engines, or hiding or shrinking the "Unofficial concept preview" banner.
- Making preview removal require an account, an email or a reason.
- Selling or brokering scouted business data.
