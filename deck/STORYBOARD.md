# Cold Open: 3-minute pitch storyboard

A 3:00 script for `deck/ColdOpen.pptx`, with one live-demo segment in Mission Control.
Speak at about 150 words a minute. **Bold** lines are the exact words to say; the rest is stage direction.

## Before you go on (T-5 min)

- **Tab 1:** the deck, in presenter view, on slide 1.
- **Tab 2:** Mission Control at https://coldopen.vnarasingamoorthy.workers.dev, full screen, with the Live challenge not yet started.
- **Tab 3:** https://coldopen.vnarasingamoorthy.workers.dev/s/arsicault-bakery, a finished site (Arsicault went 49 → 68 → 96).
- **Pick the live-challenge business in advance.** Choose one that is scouted but not built and has a website: Candlestick Park Sports Bar, The Bike Hut or Guitar Solo (Kaiyō, 58 Social and Game Post are already built). A build takes about 40–110 s; the best so far is 38.5 s (Game Post).
- **Phone hotspot on,** in case the venue Wi-Fi drops.
- **Backup:** a screen recording of one full live challenge. If the live run stalls past 100 s, switch to it and say "here's one from 20 minutes ago".

## The script

| Time | Slide / screen | What to say | Action |
|---|---|---|---|
| **0:00–0:15** | **1 · Title** | **"This morning, none of the shops on this block had a new website. Now fifteen of them do, and nobody asked us to build them. This is Cold Open: the agency that does the work before the sale."** | Pause on "nobody asked us". |
| **0:15–0:35** | **2 · Problem** | **"There are 36 million small businesses in the US. One in six still has no website. Agencies bill a hundred dollars an hour, and the owner has to say yes and pay before seeing a single pixel. The sale comes before the work."** | Point at the three stats. |
| **0:35–0:50** | **3 · Insight** | **"Agents make doing the work first nearly free: about four cents a site. So we flipped it. We build the finished site, then show it to the owner. The work is the pitch."** | Tap the "Claim · $49" and "Remove" buttons on the mock. |
| **0:50–1:05** | **4 · Demo → switch to Mission Control** | **"Here's the block, live. Real businesses from OpenStreetMap around 101 Townsend. Every card is a site our agents built today. On the right, you can watch the agents argue."** | Switch to Tab 2. Hover a pin, then a card. |
| **1:05–1:50** | **Live challenge** (still Mission Control) | Press **L**, type the chosen business, press Start. While the timer runs: **"Scout found it. The Archivist is reading their actual website: colors, fonts, what they really sell. The Builder drafts, and the Critic tears it apart. It penalizes AI slop like 'elevate' or 'nestled', and anything we can't prove, like 'family-owned since 1987'. Under 85, it goes back. Watch the score climb."** When it finishes: **"Built, taste-gated, priced and pitched. Scan it."** | Point at the split timer, then the version chart. Hold up the QR code. Open the site. |
| **1:50–2:05** | **6 · Taste gate** (skip slide 5, or flash it for 2 s) | **"This is the self-improvement loop. Arsicault Bakery started at 49. The Critic's notes quote the exact bad sentence, and three drafts later it shipped at 96. Tres went from 31 to 88. Nothing ships under 85 unflagged."** | |
| **2:05–2:20** | **7 · Architecture** | **"One Cloudflare Worker, one Durable Object on the Agents SDK holding all state, WebSockets for the live feed, and KV for media. The brain routes across Claude, OpenAI and Workers AI. Stripe does checkout with signed webhooks, and a Brainbase managed agent gives every site an independent second opinion."** | |
| **2:20–2:35** | **8 · Business model** | **"Forty-nine dollars to claim the site, and nineteen a month to keep it. The CFO agent prices every build live: one claim pays for more than a thousand sites nobody buys. Every unclaimed site is just marketing."** | |
| **2:35–2:50** | **9 · Traction** | **"Today, on one block: 24 businesses scouted, 15 sites built, 14 passed the taste gate, for 86 cents in total model spend. Our fastest build was 38 seconds."** These were the numbers at 2:28 PM; read the live tiles, since they will have grown. **Only say "paid" or "replied" if the numbers are real.** | Numbers come live from the API. |
| **2:50–3:00** | **10 · Vision + ask** | **"Every storefront on Earth gets a Cold Open. It's open source at github.com/vnmoorthy/coldopen. Give us Atlas and we incorporate tonight. Thank you."** | Hold on the QR code. |

## If a judge asks…

- **"Isn't this spam?"** "Every preview is unlisted and noindexed, and it carries a banner saying it's an unofficial concept. There's a one-click Remove that deletes it the same day. We never invent reviews, prices or history; the Critic docks points for any claim we can't source. Outreach is one personal email with an opt-out."
- **"What's real vs. mocked?"** "Everything on screen is live. The businesses come from OpenStreetMap, the brand is read from their real website, the copy comes from the live model with our critic loop, and the images come from a real image model. Checkout is Stripe in test mode, verified server-side against the Checkout Session API and a signed webhook."
- **"How much does a site cost?"** "About 3 to 8 cents in model spend; the CFO agent tracks it per build. The live number is on the traction slide."
- **"Why Cloudflare?"** "A Durable Object is the perfect HQ. It gives us single-threaded state, SQLite, WebSocket broadcast and background work in one primitive, and every generated site is served from the same Worker at the edge."
- **"Where's Brainbase?"** "Every finished site gets an independent second opinion from a Brainbase managed agent via `/v2/threads`, running on the claude_code harness. It fetches the live preview itself and scores it." Only say this if `BRAINBASE_API_KEY` is set; otherwise say "wired in; it turns on with a key."
- **"Would owners pay?"** Answer with what really happened on the walk-in. If nobody paid yet, say so honestly: "We started outreach today; here's the reply rate so far."

## Timing tips

- **If the live challenge runs long,** cut slide 5 and shorten slide 8. Never cut the live run or the ask.
- **Keep talking during builds.** Narrate the agent channel, since it shows the agents' reasoning in plain English.
- **End on the QR code** so judges can open a site themselves during deliberation.
