// Renders sample Cold Open pages to /tmp/coldopen-samples for visual QA.
// Usage: node --experimental-strip-types scripts/render-sample.mjs
// Sample businesses below are fictional; the Unsplash hero URLs are for local QA only
// (production sites use AI-generated heroes served from /img/*).
import { mkdirSync, writeFileSync } from "node:fs";
import {
  renderSite,
  renderClaimed,
  renderRemoved,
  renderRemoveConfirm,
  renderNotFound,
} from "../src/site/render.ts";

const OUT = process.env.OUT || "/tmp/coldopen-samples";
mkdirSync(OUT, { recursive: true });
const publicUrl = "https://coldopen.vnarasingamoorthy.workers.dev";
const now = Date.now();

function biz(over) {
  return {
    id: "sample",
    name: "Sample",
    category: "cafe",
    lat: 37.7786,
    lon: -122.3893,
    address: null,
    website: null,
    phone: null,
    email: null,
    openingHours: null,
    osmId: null,
    osmTags: {},
    status: "ready",
    brand: null,
    site: null,
    scores: [],
    heroImage: null,
    video: { status: "none" },
    pitch: null,
    paymentUrl: null,
    paymentVerified: false,
    paidAt: null,
    amountCents: null,
    contactedAt: null,
    repliedAt: null,
    timings: {},
    costCents: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const scores = (arr) =>
  arr.map((s, i) => ({ version: i + 1, score: s, notes: [], slopHits: [], provider: "workers-ai:llama-3.3-70b", at: now }));

const cafe = biz({
  id: "paper-moon-coffee",
  name: "Paper Moon Coffee",
  category: "cafe",
  lat: 37.77741,
  lon: -122.39402,
  address: "270 Brannan St, San Francisco, CA 94107",
  website: "https://example.com",
  phone: "+1 415 555 0142",
  openingHours: "Mo-Fr 07:00-17:00; Sa-Su 08:00-16:00",
  osmTags: { amenity: "cafe", cuisine: "coffee_shop" },
  heroImage: "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=2000&q=80",
  scores: scores([72, 81, 88]),
  brand: {
    name: "Paper Moon Coffee",
    tagline: "Slow coffee for a fast neighborhood.",
    voice: "quiet, precise, a little wry",
    vibe: "sunlit SoMa espresso bar with a reading-room calm",
    palette: { primary: "#6B3A22", secondary: "#D9C3A5", accent: "#C8553D", background: "#F6F1EA", text: "#1C1714" },
    fonts: { heading: "Fraunces", body: "Inter" },
    keywords: ["espresso", "pour-over", "pastries", "laptop-friendly", "SoMa"],
    offerings: [],
    offeringsConfirmed: false,
    story:
      "Paper Moon sits a block from South Park on Brannan Street. The listing describes a counter-service café with espresso drinks and a small food case.",
    sourceSignals: ["OSM amenity=cafe", "OSM cuisine=coffee_shop", "OSM opening_hours", "website title"],
  },
  site: {
    version: 3,
    theme: "editorial",
    headline: "Coffee worth the slow morning",
    subheadline: "Espresso, pour-over and a quiet table two blocks from the ballpark.",
    about:
      "Paper Moon Coffee is a counter-service café on Brannan Street, a short walk from South Park and the Caltrain station. Espresso drinks, filter coffee and a small case of pastries — the kind of place you duck into between meetings and end up staying.",
    highlights: [
      { title: "Pulled to order", text: "Espresso drinks made one at a time at the counter, never batched." },
      { title: "Filter, by the cup", text: "A rotating pour-over for when you want to taste the coffee itself." },
      { title: "Room to stay", text: "Tables and window seats for a slow morning or a quick 1:1." },
    ],
    offeringsTitle: "The menu",
    offerings: [
      { name: "Espresso", description: "A short, syrupy double shot." },
      { name: "Cappuccino", description: "Equal parts espresso, steamed milk and foam." },
      { name: "Pour-over", description: "Single-origin filter coffee brewed by the cup." },
      { name: "Cold brew", description: "Steeped overnight, served over ice." },
      { name: "Morning pastries", description: "A small case of baked goods, restocked daily." },
      { name: "Tea", description: "Hot loose-leaf teas for the non-coffee crowd." },
    ],
    ctaLabel: "Visit us",
    hoursText: "Mon–Fri 7–5, Sat–Sun 8–4",
    seo: { title: "Paper Moon Coffee — espresso on Brannan St", description: "Concept site for Paper Moon Coffee." },
  },
});

const med = biz({
  id: "zaytoon-street-kitchen",
  name: "Zaytoon Street Kitchen",
  category: "fast_food",
  lat: 37.78455,
  lon: -122.39648,
  address: "88 2nd St, San Francisco, CA 94105",
  phone: "(415) 555-0199",
  openingHours: "Mo-Th 11:00-21:00; Fr-Sa 11:00-23:30; Su 12:00-20:00",
  osmTags: { amenity: "fast_food", cuisine: "mediterranean;falafel" },
  heroImage: "https://images.unsplash.com/photo-1529006557810-274b9b2fc783?w=2000&q=80",
  scores: scores([79, 90]),
  brand: {
    name: "Zaytoon Street Kitchen",
    tagline: "Charcoal, garlic, lemon. Repeat.",
    voice: "loud, generous, quick",
    vibe: "sunlit Mediterranean street food",
    palette: { primary: "#1F4E3D", secondary: "#E8B04A", accent: "#E4572E", background: "#F4EDE0", text: "#14110F" },
    fonts: { heading: "Anton", body: "Space Grotesk" },
    keywords: ["shawarma", "falafel", "garlic sauce", "plates", "wraps", "late night"],
    offerings: [],
    offeringsConfirmed: false,
    story: "A counter-service Mediterranean spot on 2nd Street listed for falafel and grilled plates.",
    sourceSignals: ["OSM amenity=fast_food", "OSM cuisine=mediterranean;falafel", "OSM opening_hours"],
  },
  site: {
    version: 2,
    theme: "bold",
    headline: "Hot off the charcoal",
    subheadline: "Wraps, plates and falafel fried to order on 2nd Street. Open late on weekends.",
    about:
      "Zaytoon is a counter-service Mediterranean kitchen on 2nd Street. Grilled meats, falafel and big plates built fast for the lunch rush and the late crowd.",
    highlights: [
      { title: "Built fast", text: "Order at the counter, eat in minutes. Made for a lunch hour that's never an hour." },
      { title: "Falafel, fried to order", text: "Crisp outside, green inside, never sitting under a heat lamp." },
      { title: "Late on weekends", text: "Friday and Saturday the grill stays hot until 11:30 PM." },
    ],
    offeringsTitle: "What's on the grill",
    offerings: [
      { name: "Chicken shawarma wrap", description: "Marinated chicken, garlic sauce, pickles, fries inside." },
      { name: "Falafel plate", description: "Falafel, hummus, salad, rice and warm pita." },
      { name: "Mixed grill plate", description: "A little of everything off the charcoal." },
      { name: "Hummus & pita", description: "Tahini-rich hummus with olive oil and paprika." },
      { name: "Fattoush", description: "Crisp greens, sumac, toasted pita chips." },
      { name: "Garlic fries", description: "Fries tossed with toum and parsley." },
    ],
    ctaLabel: "Order ahead",
    hoursText: "Mo-Th 11-9, Fr-Sa 11-11:30, Su 12-8",
    seo: { title: "Zaytoon Street Kitchen — Mediterranean on 2nd St", description: "Concept site for Zaytoon." },
  },
});

const bike = biz({
  id: "spoke-and-sprocket",
  name: "Spoke & Sprocket Bike Co-op",
  category: "bicycle",
  lat: 37.77632,
  lon: -122.40588,
  address: "1015 Folsom St, San Francisco, CA 94103",
  website: "http://example.org",
  openingHours: "Tu-Fr 10:00-19:00; Sa 10:00-18:00; Su 11:00-17:00; Mo off",
  osmTags: { shop: "bicycle", "service:bicycle:diy": "yes" },
  heroImage: "https://images.unsplash.com/photo-1485965120184-e220f721d03e?w=2000&q=80",
  scores: scores([84, 91]),
  brand: {
    name: "Spoke & Sprocket Bike Co-op",
    tagline: "Fix it together.",
    voice: "friendly, hands-on, unpretentious",
    vibe: "community workshop, greasy hands, warm light",
    palette: { primary: "#2F6B4F", secondary: "#F2C57C", accent: "#E07A5F", background: "#FAF3E7", text: "#2B2118" },
    fonts: { heading: "Fraunces", body: "Nunito" },
    keywords: ["repairs", "tune-ups", "DIY stands", "used bikes", "classes"],
    offerings: [],
    offeringsConfirmed: false,
    story:
      "A bike shop on Folsom Street whose listing notes do-it-yourself repair service. Bring a bike, borrow the tools, leave knowing how it works.",
    sourceSignals: ["OSM shop=bicycle", "OSM service:bicycle:diy=yes", "OSM opening_hours"],
  },
  site: {
    version: 2,
    theme: "warm",
    headline: "Your bike, back on the road",
    subheadline: "Repairs, tune-ups and open work stands on Folsom Street — bring it in or fix it yourself.",
    about:
      "Spoke & Sprocket is a neighborhood bike shop on Folsom Street with do-it-yourself repair stands. Drop a bike off for a tune-up, or borrow the tools and a stand and learn to do it yourself.",
    highlights: [
      { title: "Open work stands", text: "Borrow a stand and the right tools. Someone's around when a bolt won't budge." },
      { title: "Tune-ups", text: "Brakes, gears and a true wheel — the basics that make a bike feel new." },
      { title: "Learn as you go", text: "Every fix is a chance to understand your bike a little better." },
    ],
    offeringsTitle: "Repairs & rentals",
    offerings: [
      { name: "Basic tune-up", description: "Brake and gear adjustment, tire pressure, safety check." },
      { name: "Flat fix", description: "Tube replacement or patch, while you wait." },
      { name: "DIY stand time", description: "A work stand and shared tools by the hour." },
      { name: "Wheel truing", description: "Straighten a wobbly wheel back into shape." },
      { name: "Used bikes", description: "Refurbished bikes, checked over before they go." },
      { name: "Fix-it basics class", description: "Small-group intro to maintenance." },
    ],
    ctaLabel: "Come by",
    hoursText: "Tue–Sun, Mon closed",
    seo: { title: "Spoke & Sprocket — bike co-op on Folsom", description: "Concept site for Spoke & Sprocket." },
  },
});

// Stress case: hostile strings, no hero, no geo, bad palette, long headline, sans heading in editorial.
const evil = biz({
  id: "evil<script>",
  name: `Mo's "Deli" <img src=x onerror=alert(1)>`,
  category: "deli",
  lat: null,
  lon: null,
  address: "500 Howard St, San Francisco",
  phone: "not a phone",
  website: "javascript:alert(1)",
  openingHours: "Mo-Fr 08:00-15:00; PH off; week 1-53",
  heroImage: "javascript:alert(1)",
  scores: scores([86]),
  brand: {
    name: "x",
    tagline: "</style><script>alert(1)</script>",
    voice: "",
    vibe: "",
    palette: { primary: "#fff", secondary: "red;}body{display:none", accent: "#ffffff", background: "#ffffff", text: "#fefefe" },
    fonts: { heading: "Inter'; } body{display:none} .x{", body: "work sans" },
    keywords: ["<b>bold</b>", "sandwiches"],
    offerings: [],
    offeringsConfirmed: true,
    story: "Story with **markdown** and a ‮bidi override.",
    sourceSignals: ["name only"],
  },
  site: {
    version: 1,
    theme: "editorial",
    headline:
      "An extraordinarily long headline that keeps going well past what a hero should hold, just to see what happens to the layout",
    subheadline: "Sub <em>with tags</em>",
    about: "About text that is fine.",
    highlights: [{ title: "Only one", text: "Just one highlight provided." }],
    offeringsTitle: "Sandwiches, soups, salads and more things than fit",
    offerings: [
      { name: "Turkey club", description: "Classic.", price: "$12" },
      { name: "Soup", description: "Daily.", price: "<script>" },
    ],
    ctaLabel: "Order ahead",
    hoursText: "Hours — owner to confirm",
    seo: { title: "", description: "" },
  },
});

const bar = biz({
  id: "blackbird-lounge",
  name: "Blackbird",
  category: "bar",
  lat: 37.78101,
  lon: -122.39213,
  address: "650 Townsend St, San Francisco, CA 94103",
  openingHours: "Tu-Sa 17:00-02:00; Su-Mo off",
  osmTags: { amenity: "bar" },
  heroImage: "https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?w=2000&q=80",
  scores: scores([80, 87]),
  brand: {
    name: "Blackbird",
    tagline: "Low light, cold glasses, good company.",
    voice: "hushed, confident",
    vibe: "moody cocktail bar",
    palette: { primary: "#C9A227", secondary: "#2B2B2B", accent: "#8C1C13", background: "#0F0E0D", text: "#F2EDE4" },
    fonts: { heading: "Playfair Display", body: "DM Sans" },
    keywords: ["cocktails", "natural wine", "late night", "Townsend"],
    offerings: [],
    offeringsConfirmed: false,
    story: "A bar on Townsend Street listed as open late Tuesday through Saturday.",
    sourceSignals: ["OSM amenity=bar", "OSM opening_hours"],
  },
  site: {
    version: 2,
    theme: "editorial",
    headline: "After dark on Townsend",
    subheadline: "Stirred drinks, a short wine list and a room that stays quiet enough to talk.",
    about:
      "Blackbird is a cocktail bar on Townsend Street that opens in the evening and stays open late, Tuesday through Saturday. Low light, a long bar and a short list done well.",
    highlights: [
      { title: "Stirred, not rushed", text: "Classic cocktails built one at a time." },
      { title: "Open late", text: "Until 2 AM Tuesday to Saturday." },
      { title: "Room to talk", text: "Music low enough for conversation." },
    ],
    offeringsTitle: "At the bar",
    offerings: [
      { name: "House martini", description: "Very cold, very dry." },
      { name: "Old fashioned", description: "Bourbon, bitters, orange." },
      { name: "Natural wine by the glass", description: "A short rotating list." },
      { name: "Bar snacks", description: "Olives, nuts, something salty." },
    ],
    ctaLabel: "Stop in",
    hoursText: "Tue–Sat 5 PM–2 AM",
    seo: { title: "Blackbird — cocktails on Townsend", description: "Concept site for Blackbird." },
  },
});

const pages = {
  "dark-editorial": renderSite(bar, { publicUrl }),
  "dark-bold": renderSite({ ...bar, site: { ...bar.site, theme: "bold" } }, { publicUrl }),
  "dark-warm": renderSite({ ...bar, site: { ...bar.site, theme: "warm" } }, { publicUrl }),
  "editorial-cafe": renderSite(cafe, { publicUrl }),
  "bold-med": renderSite(med, { publicUrl }),
  "warm-bike": renderSite(bike, { publicUrl }),
  "edge-evil": renderSite(evil, { publicUrl }),
  "edge-evil-bold": renderSite({ ...evil, site: { ...evil.site, theme: "bold" } }, { publicUrl }),
  "edge-evil-warm": renderSite({ ...evil, site: { ...evil.site, theme: "warm" } }, { publicUrl }),
  "cafe-nohero-bold": renderSite({ ...cafe, heroImage: null, site: { ...cafe.site, theme: "bold" } }, { publicUrl }),
  "cafe-paid-warm": renderSite({ ...cafe, status: "paid", site: { ...cafe.site, theme: "warm" } }, { publicUrl }),
  "bike-editorial": renderSite({ ...bike, site: { ...bike.site, theme: "editorial" } }, { publicUrl }),
  "med-warm": renderSite({ ...med, site: { ...med.site, theme: "warm" } }, { publicUrl }),
  pending: renderSite({ ...cafe, status: "building", site: null }, { publicUrl }),
  claimed: renderClaimed(
    { ...cafe, status: "paid", paidAt: now, amountCents: 4900, paymentVerified: true },
    { verified: true, publicUrl },
  ),
  "claimed-test": renderClaimed({ ...med, status: "paid", paidAt: now, amountCents: 4900 }, { verified: false, publicUrl }),
  "claimed-null": renderClaimed(null, { verified: false, publicUrl }),
  "remove-confirm": renderRemoveConfirm(bike),
  removed: renderRemoved("Spoke & Sprocket Bike Co-op"),
  "not-found": renderNotFound(),
};

for (const [k, html] of Object.entries(pages)) {
  writeFileSync(`${OUT}/${k}.html`, html);
  console.log(`${k}.html  ${(html.length / 1024).toFixed(1)} KB`);
}
