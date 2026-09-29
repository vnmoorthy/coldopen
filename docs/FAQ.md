# FAQ

Answers are based on what the code in this repository does today (the main branch). Where the project has a rule that the code does not enforce yet, the answer says so.

**For business owners**
- [I found a preview of my business. How do I remove it?](#i-found-a-preview-of-my-business-how-do-i-remove-it)
- [Is this spam?](#is-this-spam)
- [Are you pretending to be my business?](#are-you-pretending-to-be-my-business)
- [Where did you get the information on my preview?](#where-did-you-get-the-information-on-my-preview)
- [The preview says something wrong about my business.](#the-preview-says-something-wrong-about-my-business)
- [Why does it say "owner to confirm"?](#why-does-it-say-owner-to-confirm)
- [What does the $49 buy?](#what-does-the-49-buy)

**Ethics, law and data**
- [Is this legal?](#is-this-legal)
- [Do you respect robots.txt?](#do-you-respect-robotstxt)
- [What personal data does Cold Open keep?](#what-personal-data-does-cold-open-keep)
- [Does visiting a preview contact third parties?](#does-visiting-a-preview-contact-third-parties)
- [Are the images real photos of the business?](#are-the-images-real-photos-of-the-business)
- [Are the payments real?](#are-the-payments-real)

**Running it**
- [How much does it cost to run?](#how-much-does-it-cost-to-run)
- [Do I need any API keys?](#do-i-need-any-api-keys)
- [Can I run it for a different city?](#can-i-run-it-for-a-different-city)
- [Is there an offline mode?](#is-there-an-offline-mode)
- [How long does a build take?](#how-long-does-a-build-take)
- [Why is the API unauthenticated?](#why-is-the-api-unauthenticated)
- [What happens if I deploy while a build is running?](#what-happens-if-i-deploy-while-a-build-is-running)
- [Why a Durable Object instead of a database?](#why-a-durable-object-instead-of-a-database)
- [Can I use Cold Open for my own agency?](#can-i-use-cold-open-for-my-own-agency)
- [Why is it called Cold Open?](#why-is-it-called-cold-open)

---

## For business owners

### I found a preview of my business. How do I remove it?

Press **Remove this preview** in the banner at the top of the page (or in the footer), then confirm. That is all.

- It takes effect immediately, for everyone who has the link. From then on the link shows "Removed." (HTTP 410).
- The generated copy, brand kit, pitch and images are deleted. The images are purged from storage.
- No account, email or reason is needed.
- Cold Open keeps a minimal record (your business name and OpenStreetMap id, marked `removed`) so its Scout never adds you again, and so adding you by name is refused.

One honest caveat: an operator who wipes their whole board (`POST /api/reset`) also wipes that record. If a preview of your business ever reappears after you removed it, please [open an issue](https://github.com/vnmoorthy/coldopen/issues) and we will look into it. If you received an email, you can also reply "remove".

### Is this spam?

Cold Open does not send anything on its own. The Closer agent drafts a pitch; a person reads it and decides whether to send it, using a Copy button or a `mailto:` link. "Contacted" and "replied" are marked by hand. There is no email integration in the code.

The drafted pitch is short (capped at 140 words), says the site was built before asking, gives the price, and closes with "No pressure either way. Reply "remove" and we delete it the same day." The model is only allowed to write the subject line and one descriptive sentence; flattery, urgency, promises of results and exclamation marks are rejected in code.

If outreach is ever automated, it must follow the rules in [docs/ETHICS.md](ETHICS.md#rules-for-outreach): one message per business, a working opt-out, a physical address, and CAN-SPAM at minimum.

### Are you pretending to be my business?

No. Every preview carries a banner that stays on screen: *"Unofficial concept preview made for {name} by Cold Open — not the official site."* The footer repeats that it is not affiliated with or endorsed by you, and a "How this preview was made" panel lists what was read and that nothing was written or approved by you.

Previews are marked `noindex,nofollow` (both a meta tag and an `X-Robots-Tag` header), so search engines should not list them, and they are not linked from anywhere your customers would look.

### Where did you get the information on my preview?

Only from public sources, and the preview lists them:

- **OpenStreetMap:** name, category, address, coordinates, opening hours, phone and practical tags (outdoor seating, takeaway and similar).
- **Your own website's homepage** (if OpenStreetMap lists one): page title, descriptions, headings, visible text, colors, fonts, prices printed on the page and the social-share image. At most one stylesheet is also read, to find your colors.
- **Optionally, Taste Labs**, a brand-extraction service that reads the same public homepage.

Nothing comes from review sites, social networks or anything behind a login.

### The preview says something wrong about my business.

Please remove it (above). If you are willing, [open an issue](https://github.com/vnmoorthy/coldopen/issues) describing what was wrong, so we can fix the cause. Cold Open has several checks against invented claims (see [TASTE-GATE.md](TASTE-GATE.md#the-unsupported-claims-fact-check)), but models make mistakes.

### Why does it say "owner to confirm"?

Because we did not know. If your menu or services were not clearly listed on your own website, the preview shows typical items for your kind of business, **with no prices**, under a label that says *"Preview — owner to confirm"* and explains they are not your actual menu. Unknown opening hours say *"Hours — owner to confirm"*. Prices only ever appear when the same price was printed on your own site.

### What does the $49 buy?

The pitch describes it as the site handed over to you and set up on your own domain, plus a short launch ad. The page after checkout lists the next steps: confirming your real details, removing the preview banner, connecting your domain, and handing over the site files with no lock-in.

In this version, a payment marks the business as paid and records the amount; the handover itself (domain, edits, hosting) is done by hand. Automating it is on the [roadmap](../ROADMAP.md). The public demo uses Stripe **test mode**, so no real money moves there.

---

## Ethics, law and data

### Is this legal?

We are not lawyers and this is not legal advice. Here is how the project tries to stay on the right side of the obvious concerns, and what anyone deploying it is responsible for:

- **Impersonation and trademarks.** Every preview is labeled unofficial, on screen at all times, and says it is not affiliated with or endorsed by the business. The business's name is used to describe it, not to pass the site off as theirs.
- **Search competition.** Previews are `noindex,nofollow` and are not linked publicly.
- **Content.** Cold Open reads public facts from the business's homepage (item names, colors, fonts, hours) and writes new copy. It does not republish the page, but the new copy can reuse item names and short phrases from it, which is the point: it should sound like them.
- **Email.** The code does not send email. If you send the drafted pitch yourself, commercial-email law applies to you (CAN-SPAM in the U.S.; consent-based rules in places such as Canada and the EU). [docs/ETHICS.md](ETHICS.md#rules-for-outreach) summarizes the U.S. requirements.
- **Map data.** OpenStreetMap data is © OpenStreetMap contributors under the Open Database License. Attribution is shown on the map in Mission Control and under the map on every preview.
- **Payments.** Demos must use Stripe test mode. Before taking real money, publish a refund policy and verify payments with both Stripe secrets.
- **Sensitive categories.** The project's rule is not to build previews for medical, legal, financial, religious or political organizations, or for anything aimed at children. The Scout's query targets food, drink, shops and crafts, which keeps most of them out, but there is no explicit category block in code; an operator who sees one should remove it.

### Do you respect robots.txt?

**Not in code today.** It is a project rule in [docs/ETHICS.md](ETHICS.md#rules-for-data-collection), and it is on the [roadmap](../ROADMAP.md). What the code does do:

- Reads only the homepage, once per build, with an 8-second timeout and a 700 KB cap. At most one stylesheet (4 s, 200 KB) is also fetched, and the social-share image (8 s) only when no image model produced a hero.
- Never crawls links, never logs in, never fetches in parallel from the same site.
- Requests to OpenStreetMap services identify themselves as `ColdOpen/1.0 (hackathon demo)`.

Be aware that the homepage request itself uses a desktop-browser User-Agent string, because many small-business sites serve an empty page to unknown clients. Contributions that add a `robots.txt` check (see [AGENTS.md](AGENTS.md#archivist)) are welcome.

### What personal data does Cold Open keep?

- **About businesses:** public business contact data from OpenStreetMap (phone, a business email if tagged, website) and the address. No personal data about owners or staff is collected.
- **About visitors:** none stored by Cold Open. When someone opens a preview or presses "Claim it", HQ logs an anonymous event ("Someone just opened X's preview"), throttled and skipped for known bots. No IP address, cookie id or user agent is written to Cold Open's storage. Cloudflare's own platform logs (observability is enabled in `wrangler.jsonc`) may record request metadata under Cloudflare's policies.
- **About buyers:** Cold Open records that a business paid, when, how much, and whether Stripe verified it. It does not store the buyer's name, email or card details; those stay with Stripe.
- **Cookies:** one, `co_claim`, set when "Claim it" is pressed. It holds only the business id, lasts one hour, is `HttpOnly`, `Secure` and `SameSite=Lax`, and is cleared once a claim is recorded.

### Does visiting a preview contact third parties?

Yes, two:

- **Google Fonts**, for the brand's typefaces.
- **OpenStreetMap's tile server** (`tile.openstreetmap.org`), for the small map in the Visit section.

The hero image is served from Cold Open's own domain, never hotlinked from the business's site.

Mission Control, the operator dashboard (not the preview), also loads Leaflet from unpkg, map tiles from Esri, and Google Fonts, and it sends each preview's URL to api.qrserver.com to draw the Live challenge's QR code.

### Are the images real photos of the business?

No, unless the preview re-hosted the business's own social-share image (the last resort when no image model is available). Hero images are generated from a text prompt that describes a typical scene for the category and explicitly asks for no text, no logos, no signage and no close-up faces. The preview captions them "Illustrative image · AI-generated for this concept", and the footer says imagery is AI-generated and illustrative.

### Are the payments real?

Not on the public demo: it uses a Stripe **test-mode** Payment Link. Pay with the test card `4242 4242 4242 4242` and no money moves. Revenue on the live demo is $0. Cold Open only creates per-business Payment Links with a test-mode key.

---

## Running it

### How much does it cost to run?

From the live demo on Sep 28, 2026, running on OpenAI `gpt-5-mini`: about **4 to 6¢ per site** in estimated model spend, and **under $1** for the whole board (24 businesses scouted, 16 sites built).

On top of that:

- **Cloudflare.** We recommend the Workers Paid plan. Workers AI includes a free daily allocation of 10,000 neurons; with no model keys, text and images come out of it.
- **Optional integrations** (Higgsfield clips, Brainbase reviews, Taste Labs extractions) use their own credits and are not included in the CFO's spend.

The CFO's numbers are estimates from token counts and a price table in the code. Your providers' dashboards are the source of truth. Details: [DEPLOY.md](DEPLOY.md#costs).

### Do I need any API keys?

No. With only the Workers AI, KV and Durable Object bindings, the whole loop runs: scouting, brand extraction, building, the taste gate, hero images, pitches and the checkout link. Keys upgrade parts of it: OpenAI or Claude as the brain, OpenAI image fallbacks, Stripe verification, Slack, Higgsfield video, Taste Labs and Brainbase. See the README's graceful-degradation table.

### Can I run it for a different city?

Yes: set `HQ_LAT` and `HQ_LON` in `wrangler.jsonc` and redeploy. The Scout, the map and the distances follow those coordinates. Some parts are still written for San Francisco, and you should know which before you run it elsewhere:

| What | Where | Effect elsewhere |
|---|---|---|
| Neighborhood naming | `placeFor()` in `src/pipeline/brand.ts` | A business within 1.8 km of your HQ with no OSM neighborhood is called "SoMa", and the city defaults to "San Francisco" when OSM has no `addr:city`. This reaches the copy, so fix it first. |
| Landmark | `placeFor()` | "a short walk from Oracle Park" only triggers within 900 m of Oracle Park, so it simply disappears elsewhere. |
| Critic location terms | `structuralChecks()` in `critic.ts` | Also accepts "SoMa", "South Beach", "Mission Bay", "Oracle Park" and "ballpark" as proof the copy says where it is. Harmless elsewhere, but worth replacing. |
| Labels and messages | `HQ_LABEL` and event text in `src/hq.ts`, `public/index.html`, `DEFAULT_HQ` in `public/app.js` | Say "101 Townsend St" and "SoMa". |
| Pitch wording | `closer.ts` | "built at a hackathon at Cloudflare HQ" and "here in San Francisco". |
| Video fallback prompt | `startVideoFor()` in `hq.ts` | Says "in San Francisco". |
| "Open now" on previews | `src/site/render.ts` | Live open/closed status uses Pacific time and only turns on for coordinates in the U.S. West. The hours table still shows everywhere. |
| Offline scouting fallback | `src/pipeline/osm-snapshot.json` | Only covers 600 m around 101 Townsend St. Elsewhere, if every Overpass mirror is down, scouting fails instead of falling back. |

Making these configurable (named blocks with their own coordinates, labels and neighborhood names) is on the [roadmap](../ROADMAP.md).

### Is there an offline mode?

Partly. There are three different fallbacks, and none of them makes the backend fully offline:

1. **UI-only mock.** Open Mission Control with `?mock=1` (for example `http://localhost:8787/?mock=1`). `public/mock.js` then simulates the HTTP API and WebSocket in memory, with invented sample businesses, so the interface can be reviewed without a running Worker. A "Mock data" badge is shown the whole time. None of that data is real, and none of it is used by the product.
2. **Offline scouting.** If every public Overpass mirror is down, the Scout reads a bundled OpenStreetMap snapshot of the block around 101 Townsend St (87 elements within 600 m, captured Sep 28, 2026).
3. **No-model builds.** If no language model answers, every agent still produces something honest: a category-preset brand, a factual template site, a heuristic score and a template pitch. Hero images fall back to the business's own social image or a typographic hero.

Workers AI always runs on Cloudflare, even under `wrangler dev`, so a build needs network access to Cloudflare at minimum.

### How long does a build take?

On the live demo, about a minute on average from Archivist to Closer. The fastest was Game Post in 38.5 s (it scored 96 on its first pass). A build that needs all three taste-gate versions takes longer, and each stage has a hard timeout (see [ARCHITECTURE.md](ARCHITECTURE.md#12-timeouts-and-limits-at-a-glance)).

### Why is the API unauthenticated?

The public deployment is a hackathon demo on public data, and the judges needed to press every button. Anyone with the URL can scout, build, reset or remove. For any real use, put Mission Control and `/api/*` (except the Stripe webhook) behind Cloudflare Access or similar. See [SECURITY.md](../SECURITY.md) and [DEPLOY.md](DEPLOY.md#before-you-run-it-in-public).

Preview removal is deliberately open to anyone with the link: taking a preview down should never require proof.

### What happens if I deploy while a build is running?

The deploy restarts the Durable Object, and the builds in flight stop. On restart HQ marks them "Build interrupted by a server restart — resuming automatically." and rebuilds the first six about two seconds later; any beyond six wait for a manual Rebuild. Data already saved is kept. Avoid deploying during a live demo.

### Why a Durable Object instead of a database?

HQ is a single coordinator with its own SQLite storage and a WebSocket to every open Mission Control. State changes and broadcasts happen in one place, in order, so several agents working on many businesses never race each other. There is no connection pool, no ORM and no second service to deploy. The trade-off is one instance per deployment, which is the right size for one neighborhood board. [ARCHITECTURE.md](ARCHITECTURE.md#3-the-hq-durable-object) has the details.

### Can I use Cold Open for my own agency?

The code is MIT-licensed, so yes. If you point it at real businesses, [docs/ETHICS.md](ETHICS.md) is the part that matters: keep the banner and `noindex`, keep the two-click removal, never invent social proof or prices, send outreach by hand and lawfully, and verify payments before you celebrate them.

### Why is it called Cold Open?

In television, the cold open is the scene that plays before the title card. You are already in the story before anyone introduces it. Here, the work plays before the pitch.
