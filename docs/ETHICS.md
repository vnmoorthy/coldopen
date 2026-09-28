# Ethics and safety

Cold Open builds websites for real small businesses that did not ask for one, and then offers to sell it to them. Done carelessly, that is impersonation, spam, or both. This document is how we keep it neither. It applies to the code in this repository, to anyone who deploys it, and to every contribution.

If you are a business owner and found a Cold Open preview of your business: press **Remove this preview** in the banner at the top of the page and confirm. It stops being served immediately. You do not need an account or an email, and you do not need to tell anyone why.

## The four promises

1. **We never pretend to be you.** Every preview says, on screen at all times, that it is an unofficial concept made by Cold Open.
2. **We never make things up about you.** No reviews, ratings, awards, testimonials, prices or history that we did not read on your own site.
3. **We never compete with you.** Previews are hidden from search engines and are not linked from anywhere your customers would look.
4. **You can make it disappear in two clicks.** Removal is on every page and takes effect immediately.

## What the code enforces today

These are properties of the current build, not aspirations. A change that breaks any of them is a bug.

| Safeguard | Where | What it does |
|---|---|---|
| Preview banner | `src/site/render.ts` | Sticky banner on every generated page: *"Unofficial concept preview made for {name} by Cold Open — not the official site."* with **Claim it · $49** and **Remove this preview**. |
| No indexing | `src/site/render.ts` | `<meta name="robots" content="noindex,nofollow">` on every preview. |
| One-click takedown | `/s/:id/remove`, `DELETE /api/businesses/:id` | Confirmation page with one button. Status becomes `removed`; the URL shows a removed page from then on; Mission Control drops the card. |
| Offerings honesty | `Brand.offeringsConfirmed` | `true` only when offerings came from the business's own site. Otherwise category-typical descriptions, **no prices**, and the section is labeled *"Preview — owner to confirm"*. |
| Hours honesty | `SiteSpec.hoursText` | From OSM `opening_hours` when present, otherwise *"Hours — owner to confirm"*. |
| Provenance | `Brand.sourceSignals` | The Archivist records exactly what it read ("website title", "theme-color #…", "OSM cuisine=…"). The story it writes must be factual; no invented history. |
| Slop check | `src/pipeline/critic.ts` | A deterministic list of stock marketing phrases is matched and penalized, independent of any model. |
| No chains | `src/pipeline/scout.ts` | Places tagged `brand`, `brand:wikidata`, `brand:wikipedia` or `operator:wikidata` are skipped. Cold Open is for independents. |
| Bounded crawling | `src/pipeline/scout.ts`, `src/pipeline/brand.ts` | One homepage fetch per business with an 8 second timeout. Overpass mirrors are tried one at a time, with a backup started only when the first is slow. Overpass requests identify themselves with a `ColdOpen/1.0` User-Agent. |
| Test-mode money | `src/integrations/stripe.ts` | The demo checkout is a Stripe test-mode Payment Link. Per-business Payment Links are only created when the key is a test key. |
| Verified payments | `src/integrations/stripe.ts` | With `STRIPE_WEBHOOK_SECRET`, webhooks are HMAC-verified with a 5 minute replay window and constant-time comparison. With `STRIPE_SECRET_KEY`, `/claimed` checks the session with Stripe. Without a key, payments are recorded with `paymentVerified: false`. |
| No automatic sending | Mission Control | The Closer drafts a pitch. Sending is a person's decision (Copy, or a `mailto:` link). Contacted and replied are marked by hand. |

## Rules for generated content

- **Label it.** The banner is not optional and must not be hidden, shrunk, made transparent or moved off-screen by any theme.
- **Use their words, not ours.** Headlines and copy should come from what the business says about itself. The Critic is instructed to penalize generic copy.
- **Never fabricate social proof.** No reviews, star ratings, review counts, "as seen in", awards, customer quotes or follower numbers. Not even as placeholders.
- **Never invent prices.** If a price was not on the business's own site, it does not appear.
- **Never invent facts.** No founding years, family histories, chef biographies, sourcing claims or certifications unless they were read from the business's own site.
- **Generated imagery is illustrative.** Hero images are made by FLUX from a text prompt. Prompts must not request real people, the business's staff, its logo, or a depiction presented as the actual premises.
- **No sensitive categories.** Do not generate previews for medical, legal, financial, religious or political organizations, or for anything aimed at children. The Scout's category list should keep them out; if one slips through, remove it.

## Rules for data collection

- **Public sources only.** Business data comes from OpenStreetMap and the business's own public homepage. Nothing behind a login, nothing from review sites, nothing from social networks.
- **Respect robots.txt and rate limits.** If a site disallows automated access, the Archivist should work from OSM tags alone. One fetch per business per build, with a timeout. Never parallel-hammer a single host.
- **Respect the public Overpass mirrors.** They are run by volunteers and organizations as a public good. Keep radius and limit modest, do not loop scouting, and back off on errors.
- **Attribute OpenStreetMap.** Map data is © OpenStreetMap contributors under the [Open Database License](https://www.openstreetmap.org/copyright). Keep the attribution visible in Mission Control's map.
- **Business contact data only.** Phone, email and website are stored only if they are published as business contact details in OSM or on the business's own site. No personal data about owners or staff.
- **No resale.** Scouted data is for building previews, not for list-selling or lead brokering.

## Rules for outreach

The current build does not send email. When outreach is automated (it is on the roadmap, via Cloudflare Email Service), it must meet the U.S. CAN-SPAM Act at minimum. The FTC's [compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) lists the requirements, summarized here:

- accurate From, To, Reply-To and routing information;
- a subject line that is not deceptive;
- a clear disclosure that the message is an offer;
- a valid physical postal address for the sender;
- a clear, working way to opt out, honored within 10 business days, and kept working for at least 30 days after sending;
- the sender stays responsible even when a vendor does the sending.

The FTC guide notes that each violating email can cost up to $53,088. Beyond the law, Cold Open's own rules:

- **One message per business.** No sequences, no "just bumping this", unless they reply.
- **Say what it is.** The pitch states that we built an unofficial preview, what it costs, and how to remove it, in plain words.
- **Opt-out means everything.** An opt-out removes the preview too, and the business is suppressed from future scouting.
- **No pressure tactics.** No fake deadlines, no "your site is at risk", no implying the preview is already public to their customers.
- Outside the U.S., follow local law (for example, consent-based rules for commercial email in Canada and the EU). If in doubt, do not send.

## Rules for payments

- **Clear price.** The price is on the button: **Claim it · $49**. No upsells inside checkout.
- **Test mode in demos.** Public demos must use Stripe test mode. Never put a live key into a hackathon deployment.
- **Verify before you celebrate.** In any deployment that takes real money, set `STRIPE_WEBHOOK_SECRET` and `STRIPE_SECRET_KEY` so every payment is verified with Stripe.
- **Publish a refund policy** before accepting real payments, and honor it.

## Known limitations

We would rather list these than have you find them.

- **The demo API has no authentication.** Anyone with the URL can scout, build, reset or remove. That is acceptable for a public hackathon demo on public data. A real deployment should put `/api/*` behind Cloudflare Access or similar, while keeping the owner-facing routes and the webhook public.
- **Anyone with a preview link can remove it.** That is deliberate: takedown should fail safe, and an owner should never need to prove anything to make a preview go away.
- **Unverified webhooks without a secret.** Without `STRIPE_WEBHOOK_SECRET`, webhook events cannot be signature-checked. Fine in test mode, not with real money.
- **Models make mistakes.** The Critic and the deterministic checks catch a lot, but not everything. If a preview says something untrue about your business, remove it and, if you are willing, [open an issue](https://github.com/vnmoorthy/coldopen/issues) so we can fix the cause.

## Reporting a problem

- **Owners:** use **Remove this preview** on the page. That is the fastest path and needs nothing from you.
- **Everyone else:** open an issue at [github.com/vnmoorthy/coldopen/issues](https://github.com/vnmoorthy/coldopen/issues). For a security issue, please do not include exploit details in a public issue; open an issue asking for a private contact instead.
