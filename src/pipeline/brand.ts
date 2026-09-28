// Archivist: extracts a real brand kit from a business's own website (or infers one tastefully
// from OSM facts when there is no site). Every claim is grounded; palette and fonts are validated.

import type { Brand, Business, Env } from "../types";
import { llmJSON } from "../llm";
import { tasteEnabled, tasteExtractBrand } from "../integrations/taste";

// =============================================================================================
// Shared helpers (also used by builder / critic / director / closer)

const ORACLE_PARK = { lat: 37.7786, lon: -122.3893 };

function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface Place {
  neighborhood: string; // "SoMa"
  city: string; // "San Francisco"
  landmark: string | null; // "Oracle Park"
  metersFromHQ: number | null;
  phrase: string; // "SoMa, San Francisco, a short walk from Oracle Park"
}

export function placeFor(biz: Business, env?: Env): Place {
  const hqLat = Number(env?.HQ_LAT ?? ORACLE_PARK.lat);
  const hqLon = Number(env?.HQ_LON ?? ORACLE_PARK.lon);
  const hasPos = typeof biz.lat === "number" && typeof biz.lon === "number";
  const fromHQ = hasPos ? distM(biz.lat as number, biz.lon as number, hqLat, hqLon) : null;
  const fromPark = hasPos ? distM(biz.lat as number, biz.lon as number, ORACLE_PARK.lat, ORACLE_PARK.lon) : null;
  const nomi = biz.osmTags?.["nominatim:neighbourhood"];
  let neighborhood = "San Francisco";
  if (nomi && !/^south of market$/i.test(nomi)) neighborhood = nomi;
  else if (nomi || (fromHQ !== null && fromHQ <= 1800)) neighborhood = "SoMa";
  const city = biz.osmTags?.["addr:city"] || "San Francisco";
  const landmark = fromPark !== null && fromPark <= 900 ? "Oracle Park" : null;
  const phrase =
    neighborhood === "San Francisco"
      ? "San Francisco"
      : `${neighborhood}, ${city}${landmark ? `, a short walk from ${landmark}` : ""}`;
  return { neighborhood, city, landmark, metersFromHQ: fromHQ === null ? null : Math.round(fromHQ), phrase };
}

const CATEGORY_LABELS: Record<string, string> = {
  cafe: "café", restaurant: "restaurant", bar: "bar", pub: "pub", fast_food: "quick-service spot",
  ice_cream: "ice cream shop", bakery: "bakery", books: "bookshop", bicycle: "bike shop", games: "game store",
  musical_instrument: "guitar and music shop", dry_cleaning: "dry cleaner", laundry: "laundry",
  massage: "massage studio", beauty: "beauty studio", hairdresser: "hair salon", barber: "barbershop",
  wine: "wine shop", alcohol: "bottle shop", gift: "gift shop", art: "art shop", clothes: "clothing boutique",
  shoes: "shoe store", florist: "florist", convenience: "corner store", deli: "deli", tattoo: "tattoo studio",
  pet: "pet shop", jewelry: "jewelry studio", optician: "optician", furniture: "furniture store",
  coffee: "coffee roaster", tea: "tea shop", chocolate: "chocolatier", confectionery: "sweet shop",
  pastry: "pastry shop", butcher: "butcher", seafood: "fish market", greengrocer: "produce market",
  supermarket: "grocery", cosmetics: "beauty shop", electronics: "electronics shop", mobile_phone: "phone shop",
  hardware: "hardware store", stationery: "stationery shop", toys: "toy store", sports: "sports shop",
  outdoor: "outdoor shop", interior_decoration: "interior design shop", nutrition_supplements: "nutrition shop",
  brewery: "brewery", winery: "winery", distillery: "distillery", photographer: "photo studio",
  fitness_centre: "fitness studio", yoga: "yoga studio", nightclub: "club", biergarten: "beer garden",
  food_court: "food hall", cannabis: "dispensary", bag: "bag shop", fabric: "fabric shop", frame: "frame shop",
  copyshop: "print shop", car_repair: "auto shop", bicycle_rental: "bike rental", travel_agency: "travel agency",
};

const CUISINE_WORDS: Record<string, string> = {
  mexican: "Mexican", tacos: "tacos", indian: "Indian", argentinian: "Argentinian", japanese: "Japanese",
  chinese: "Chinese", thai: "Thai", vietnamese: "Vietnamese", korean: "Korean", italian: "Italian",
  pizza: "pizza", french: "French", mediterranean: "Mediterranean", greek: "Greek", lebanese: "Lebanese",
  middle_eastern: "Middle Eastern", peruvian: "Peruvian", american: "American", burger: "burgers",
  sandwich: "sandwiches", coffee_shop: "coffee", bagel: "bagels", sushi: "sushi", ramen: "ramen",
  seafood: "seafood", steak_house: "steakhouse", bbq: "barbecue", bar_and_grill: "bar & grill",
  breakfast: "breakfast", brunch: "brunch", vegan: "vegan", vegetarian: "vegetarian", ice_cream: "ice cream",
  bubble_tea: "bubble tea", poke: "poké", hot_dog: "hot dogs", donut: "donuts", crepe: "crêpes",
  spanish: "Spanish", tapas: "tapas", filipino: "Filipino", ethiopian: "Ethiopian", nepalese: "Nepalese",
  tibetan: "Tibetan", himalayan: "Himalayan", salad: "salads", juice: "juice", dessert: "desserts",
  cake: "cakes", bakery: "baked goods", noodle: "noodles", dumpling: "dumplings", dim_sum: "dim sum",
  german: "German", irish: "Irish", brazilian: "Brazilian", cuban: "Cuban", caribbean: "Caribbean",
  hawaiian: "Hawaiian", californian: "Californian", regional: "regional", tea: "tea", wine: "wine", beer: "beer",
  cocktails: "cocktails", chicken: "chicken", fried_chicken: "fried chicken", falafel: "falafel", kebab: "kebab",
  sausage: "sausages", soup: "soup", fish_and_chips: "fish & chips", asian: "Asian", fusion: "fusion",
};

export function cuisineList(biz: Business): string[] {
  const raw = biz.osmTags?.["cuisine"] || "";
  return raw
    .split(/[;,]/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .map((c) => CUISINE_WORDS[c] || c.replace(/_/g, " "));
}

export function categoryLabel(biz: Business): string {
  const cat = (biz.category || "").toLowerCase().trim();
  const cuisines = cuisineList(biz);
  const nationality = cuisines.find((c) => /^[A-Z]/.test(c) && c !== "American");
  if (cat === "cafe" && cuisines.includes("coffee") && !nationality) return "coffee shop";
  if ((cat === "restaurant" || cat === "cafe" || cat === "bar" || cat === "fast_food") && nationality) return `${nationality} ${CATEGORY_LABELS[cat] || cat}`;
  if (CATEGORY_LABELS[cat]) return CATEGORY_LABELS[cat];
  return cat ? cat.replace(/_/g, " ") : "local business";
}

export function isFoodish(biz: Business): boolean {
  return /^(cafe|restaurant|bar|pub|fast_food|ice_cream|bakery|food_court|biergarten|deli|coffee|tea|pastry|confectionery|chocolate|wine|alcohol|brewery|winery|distillery|butcher|seafood|greengrocer)$/.test(
    (biz.category || "").toLowerCase(),
  );
}

// ---- colors --------------------------------------------------------------------------------

export function normHex(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  const rgb = s.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((x) => Math.max(0, Math.min(255, Number(x))));
    return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  if (!s.startsWith("#")) s = "#" + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s.slice(1).split("").map((c) => c + c).join("");
  if (/^#[0-9a-f]{8}$/.test(s)) s = s.slice(0, 7);
  if (!/^#[0-9a-f]{6}$/.test(s)) return null;
  return s.toUpperCase();
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return rgbToHex(l * 255, l * 255, l * 255);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbToHex(f(hue + 1 / 3) * 255, f(hue) * 255, f(hue - 1 / 3) * 255);
}

function isNeutral(hex: string): boolean {
  const [, s, l] = rgbToHsl(hex);
  return s < 0.14 || l > 0.94 || l < 0.07;
}

/** Saturated and mid-toned enough to carry a brand (not a pale tint, not near-black). */
function brandable(hex: string): boolean {
  const [, sat, l] = rgbToHsl(hex);
  return sat >= 0.25 && l >= 0.15 && l <= 0.78;
}

function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/** Moves `fg` lighter or darker (keeping hue) until it reaches `min` contrast against `bg`. */
export function ensureContrast(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return fg;
  const [h, s, l0] = rgbToHsl(fg);
  const bgDark = luminance(bg) < 0.25;
  let l = l0;
  for (let i = 0; i < 40; i++) {
    l = bgDark ? Math.min(1, l + 0.025) : Math.max(0, l - 0.025);
    const c = hslToHex(h, s, l);
    if (contrast(c, bg) >= min) return c;
  }
  return bgDark ? "#FFFFFF" : "#111111";
}

// ---- fonts ---------------------------------------------------------------------------------

export const FONT_ALLOWLIST = [
  // display & serif
  "Fraunces", "Playfair Display", "DM Serif Display", "Instrument Serif", "Cormorant Garamond", "EB Garamond",
  "Libre Baskerville", "Lora", "Merriweather", "Source Serif 4", "Newsreader", "Young Serif", "Gloock",
  "Abril Fatface", "Alfa Slab One", "Roboto Slab", "Crimson Pro", "Spectral",
  // grotesk & sans
  "Inter", "DM Sans", "Manrope", "Work Sans", "Karla", "Space Grotesk", "Bricolage Grotesque", "Syne",
  "Outfit", "Plus Jakarta Sans", "Montserrat", "Poppins", "Raleway", "Josefin Sans", "Libre Franklin",
  "IBM Plex Sans", "Rubik", "Nunito", "Figtree", "Sora", "Archivo", "Public Sans", "Lexend",
  // condensed & loud
  "Oswald", "Bebas Neue", "Anton", "Archivo Black", "Barlow Condensed", "Big Shoulders Display", "Unbounded",
  // hand & mono
  "Caveat", "Pacifico", "Permanent Marker", "Shrikhand", "Space Mono", "JetBrains Mono", "IBM Plex Mono",
  // more families the site renderer ships tuned axis specs for
  "Bodoni Moda", "Alegreya", "Zilla Slab", "Arvo", "Prata", "DM Serif Text", "Instrument Sans", "Familjen Grotesk",
  "Chivo", "Epilogue", "Barlow", "Quicksand", "Nunito Sans", "Righteous", "Lobster", "Staatliches", "Bungee",
];
const FONT_SET = new Map(FONT_ALLOWLIST.map((f) => [f.toLowerCase(), f]));

/** Maps any font name to a real Google Fonts family (allowlisted or seen on the business's own site). */
export function resolveFont(name: unknown, role: "heading" | "body", siteGoogleFonts: string[] = []): string {
  const raw = typeof name === "string" ? name.replace(/["']/g, "").split(",")[0].trim() : "";
  const n = raw.toLowerCase();
  if (FONT_SET.has(n)) return FONT_SET.get(n) as string;
  const fromSite = siteGoogleFonts.find((f) => f.toLowerCase() === n);
  if (fromSite) return fromSite;
  if (!n) return role === "heading" ? "Fraunces" : "Inter";
  const rules: [RegExp, string, string][] = [
    [/mono|courier|code/, "JetBrains Mono", "IBM Plex Mono"],
    [/didot|bodoni|playfair|vogue|fashion/, "Playfair Display", "Lora"],
    [/garamond|caslon|jenson|sabon|minion/, "EB Garamond", "EB Garamond"],
    [/baskerville|times|georgia|tiempos|publico|freight|chronicle|charter/, "Libre Baskerville", "Source Serif 4"],
    [/recoleta|cooper|windsor|souvenir|canela|domaine|ogg|gt super|editorial/, "Fraunces", "Lora"],
    [/slab|rockwell|clarendon|egyptian|archer/, "Roboto Slab", "Roboto Slab"],
    [/serif|roman|book|text/, "Fraunces", "Source Serif 4"],
    [/condensed|compressed|gothic|impact|knockout|league|din|bebas|druk|trade/, "Oswald", "Barlow Condensed"],
    [/script|brush|hand|marker|casual|sign/, "Caveat", "DM Sans"],
    [/futura|avenir|gotham|proxima|brandon|circular|geometric|century|montserrat|nexa|sofia/, "Outfit", "DM Sans"],
    [/grotesk|grotesque|helvetica|arial|haas|akzidenz|aktiv|univers|franklin|neue|sans/, "Space Grotesk", "Inter"],
  ];
  for (const [re, heading, body] of rules) if (re.test(n)) return role === "heading" ? heading : body;
  return role === "heading" ? "Fraunces" : "Inter";
}

// =============================================================================================
// Website reading

export interface SiteEvidence {
  url: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  siteName: string | null;
  themeColor: string | null;
  colors: { hex: string; count: number }[]; // most frequent first
  googleFonts: string[];
  cssFonts: string[];
  headings: string[];
  text: string; // visible text, <= 3000 chars
  prices: string[]; // "$12", "$4.50" as they appear
}

// Per-isolate cache so later stages (builder, critic) can check claims against what was read.
const evidenceCache = new Map<string, SiteEvidence | null>();
export function getSiteEvidence(bizId: string): SiteEvidence | null {
  return evidenceCache.get(bizId) ?? null;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  const buf = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.byteLength - off);
    if (take <= 0) break;
    buf.set(c.subarray(0, take), off);
    off += take;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", hellip: "…", eacute: "é", egrave: "è", ntilde: "ñ", aacute: "á", oacute: "ó",
  iacute: "í", uacute: "ú", uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç", middot: "·", bull: "•", copy: "©",
  reg: "®", trade: "™", deg: "°", frac12: "½", times: "×", laquo: "«", raquo: "»",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function clean(s: string | null | undefined, max = 300): string | null {
  if (!s) return null;
  const t = decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const val = `\\s*=\\s*(?:"([^"]*)"|'([^']*)')`;
  const re1 = new RegExp(`<meta\\b[^>]*?(?:name|property)\\s*=\\s*["']${k}["'][^>]*?content${val}`, "i");
  const re2 = new RegExp(`<meta\\b[^>]*?content${val}[^>]*?(?:name|property)\\s*=\\s*["']${k}["']`, "i");
  const m = html.match(re1) || html.match(re2);
  return clean(m ? (m[1] ?? m[2] ?? null) : null);
}

function absUrl(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href), base);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

// Framework defaults that show up in page CSS but say nothing about the brand
// (WordPress block presets, Elementor globals, Bootstrap, common theme defaults).
const DEFAULT_COLORS = new Set([
  "#ABB8C3", "#F78DA7", "#CF2E2E", "#FF6900", "#FCB900", "#7BDCB5", "#00D084", "#8ED1FC", "#0693E3", "#9B51E0",
  "#32373C", "#6EC1E4", "#54595F", "#7A7A7A", "#61CE70", "#007BFF", "#6C757D", "#28A745", "#DC3545", "#FFC107",
  "#17A2B8", "#343A40", "#F8F9FA", "#0D6EFD", "#198754", "#0DCAF0", "#6610F2", "#6F42C1", "#D63384", "#FD7E14",
  "#20C997", "#0274BE", "#1E73BE", "#3A3A3A", "#0000EE", "#551A8B", "#2EA3F2", "#0170B9", "#4169E1", "#7A00DF",
  "#2874FC", "#020381", "#00A0D2", "#0073AA", "#21759B", "#E1306C", "#1877F2", "#1DA1F2", "#FF0000", "#25D366",
  "#720EEC", "#7F54B3", "#A46497", "#96588A", "#4054B2", "#818A91", "#3B5998", "#CCFFFF", "#2EA2CC", "#007518",
  "#AA0000", "#FFBA00", "#006AFF", "#73859F", "#2B333F",
  // WordPress admin/notice palette
  "#DC3232", "#46B450", "#F56E28", "#FFB900", "#00A32A", "#D63638", "#DBA617", "#72AEE6", "#2271B1", "#135E96", "#23282D",
]);

const NOT_A_FONT =
  /^(inherit|initial|unset|var\(|sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-|-apple-system|blinkmacsystemfont|arial|helvetica|times|segoe|roboto$|icons?\b|.*icons?$|font ?awesome|fa\b|fa-|dashicons|eicons|elementor|swiper|slick|star$|woocommerce|videojs|video-js|simple-calendar|icomoon|fontello|genericons|glyphicons|material|themify|linearicons|ionicons|etmodules|revicons|flexslider|social|sq-|wix|squarespace|lucida|courier|verdana|tahoma|trebuchet|georgia$|menlo|monaco|consolas|sf mono|sf pro|san francisco|apple color emoji|noto color emoji|emoji)/i;

function fontCandidate(raw: string): string | null {
  const first = decodeEntities(raw).split(",")[0].replace(/["']/g, "").replace(/!important/i, "").trim();
  if (!first || first.length < 3 || first.length > 40) return null;
  if (NOT_A_FONT.test(first)) return null;
  if (/[{}();:]/.test(first)) return null;
  if (/^[a-z0-9-]+$/.test(first) && first.includes("-") && !/-(pt|web|std|pro|display|text|sans|serif)$/.test(first)) return null; // css-ish ids
  return first;
}

function stripFrameworkCss(css: string): string {
  return css
    .replace(/--wp--preset--[\w-]+\s*:[^;}]*[;}]?/gi, "")
    .replace(/--wp-admin[\w-]*\s*:[^;}]*[;}]?/gi, "")
    .replace(/\.has-[\w-]+-(?:color|background-color|gradient-background)\s*\{[^}]*\}/gi, "")
    .replace(/#wpadminbar[^{]*\{[^}]*\}/gi, "");
}

function countColors(rawCss: string, into: Map<string, number>, weight = 1) {
  const css = stripFrameworkCss(rawCss);
  const re = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|rgba?\(\s*\d{1,3}[\s,]+\d{1,3}[\s,]+\d{1,3}[^)]*\)/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(css)) && n < 20000) {
    n++;
    const raw = m[0];
    if (/rgba\(/i.test(raw)) {
      const alpha = raw.match(/,\s*([\d.]+)\s*\)$/);
      if (alpha && Number(alpha[1]) < 0.5) continue; // translucent overlays aren't brand colors
    }
    const hex = normHex(raw);
    if (hex && !DEFAULT_COLORS.has(hex)) into.set(hex, (into.get(hex) || 0) + weight);
  }
}

function fontsFromGoogleHref(href: string): string[] {
  const out: string[] = [];
  const decoded = decodeEntities(href);
  const re = /family=([^&:]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decoded))) {
    for (const fam of decodeURIComponent(m[1].replace(/\+/g, " ")).split("|")) {
      const name = fam.split(":")[0].trim();
      if (/^[A-Za-z0-9 ]{2,40}$/.test(name)) out.push(name);
    }
  }
  return out;
}

function visibleText(html: string): string {
  let s = html
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|select)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr|\/header|\/footer)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const lines = s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l.length > 1);
  // Drop repeated nav/footer lines.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const k = l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out.join("\n").slice(0, 3000);
}

export function parseSite(rawHtml: string, url: string, finalUrl = url): SiteEvidence {
  // Inline scripts (framework state, analytics) are most of the bytes on modern sites and carry
  // nothing we read; dropping them once keeps every later pass cheap on CPU.
  const html = rawHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null, 160);
  const description = metaContent(html, "description");
  const ogTitle = metaContent(html, "og:title");
  const ogDescription = metaContent(html, "og:description");
  const ogImage = absUrl(metaContent(html, "og:image"), finalUrl);
  const siteName = metaContent(html, "og:site_name");
  const themeColor = normHex(metaContent(html, "theme-color") || metaContent(html, "msapplication-TileColor") || "");

  const colorCounts = new Map<string, number>();
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  for (const b of styleBlocks) countColors(b, colorCounts);
  const styleAttrs = html.match(/style=["'][^"']*["']/gi) || [];
  for (const a of styleAttrs) countColors(a, colorCounts, 2); // inline styles are deliberate choices
  if (themeColor) colorCounts.set(themeColor, (colorCounts.get(themeColor) || 0) + 25);

  const googleFonts = new Set<string>();
  const gfRe = /fonts\.googleapis\.com\/css2?\?[^"'\s)>]+/gi;
  let gm: RegExpExecArray | null;
  while ((gm = gfRe.exec(html))) for (const f of fontsFromGoogleHref(gm[0])) googleFonts.add(f);

  const cssFonts = new Set<string>();
  const ffRe = /font-family\s*:\s*([^;}"]+)/gi;
  let fm: RegExpExecArray | null;
  while ((fm = ffRe.exec(html)) && cssFonts.size < 12) {
    const f = fontCandidate(fm[1]);
    if (f) cssFonts.add(f);
  }

  const headings: string[] = [];
  const hRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hRe.exec(html)) && headings.length < 14) {
    const t = clean(hm[2], 140);
    if (t && t.length > 1 && !headings.includes(t)) headings.push(t);
  }

  const text = visibleText(html);
  const prices = Array.from(new Set((text.match(/\$\s?\d{1,3}(?:\.\d{2})?/g) || []).map((p) => p.replace(/\s/g, "")))).slice(0, 40);

  const colors = Array.from(colorCounts.entries())
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 16);

  return {
    url,
    finalUrl,
    title,
    description,
    ogTitle,
    ogDescription,
    ogImage,
    siteName,
    themeColor,
    colors,
    googleFonts: Array.from(googleFonts).slice(0, 6),
    cssFonts: Array.from(cssFonts).slice(0, 8),
    headings,
    text,
    prices,
  };
}

async function fetchCss(href: string): Promise<string> {
  try {
    const res = await fetch(href, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/css,*/*;q=0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return "";
    const len = Number(res.headers.get("content-length") || "0");
    if (len > 200_000) return "";
    return await readCapped(res, 200_000);
  } catch {
    return "";
  }
}

/** Fetches and parses a business website. Returns null if it can't be read as HTML. */
export async function readWebsite(url: string): Promise<SiteEvidence | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct && !/html|xml|text\/plain/i.test(ct)) return null;
  let html: string;
  try {
    html = await readCapped(res, 700_000);
  } catch {
    return null;
  }
  if (!/<html|<body|<head|<title/i.test(html)) return null;
  const finalUrl = res.url || url;
  const ev = parseSite(html, url, finalUrl);

  // Cheap extra: first same-site stylesheet when inline CSS gave us few brand colors.
  const chromatic = ev.colors.filter((c) => !isNeutral(c.hex));
  if (chromatic.length < 3 || ev.googleFonts.length === 0) {
    const links = html.match(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi) || [];
    for (const l of links) {
      const href = absUrl(l.match(/href=["']([^"']+)["']/i)?.[1] ?? null, finalUrl);
      if (!href) continue;
      if (/fonts\.googleapis\.com/.test(href)) continue;
      if (/bootstrap|font-?awesome|jquery|wp-includes|dashicons|elementor\/assets\/lib|swiper|slick|animate\.css/i.test(href)) continue;
      const css = await fetchCss(href);
      if (css) {
        const counts = new Map<string, number>(ev.colors.map((c) => [c.hex, c.count]));
        countColors(css, counts);
        ev.colors = Array.from(counts.entries())
          .map(([hex, count]) => ({ hex, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 16);
        const gi = css.match(/fonts\.googleapis\.com\/css2?\?[^"'\s)]+/gi) || [];
        for (const g of gi) for (const f of fontsFromGoogleHref(g)) if (!ev.googleFonts.includes(f)) ev.googleFonts.push(f);
        const ffRe = /font-family\s*:\s*([^;}]+)/gi;
        let fm: RegExpExecArray | null;
        while ((fm = ffRe.exec(css)) && ev.cssFonts.length < 8) {
          const first = fontCandidate(fm[1]);
          if (first && !ev.cssFonts.includes(first)) ev.cssFonts.push(first);
        }
      }
      break; // only the first candidate: keep it cheap
    }
  }
  return ev;
}

// =============================================================================================
// Brand synthesis

const RISKY_CLAIM =
  /\b(since|established|est\.|founded|family[- ]owned|family[- ]run|generations?|award|voted|best in|best of|famous|legendary|beloved|iconic|michelin|star(red)?|rated|reviews?|critics?|acclaimed|renowned|original recipe|secret recipe|grandmother|abuela|nonna|decades?|years of|19\d\d|20\d\d)\b/i;

function normText(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9$.]+/g, " ").trim();
}

function supportedBy(sentence: string, evidence: string): boolean {
  const re = new RegExp(RISKY_CLAIM.source, "gi");
  for (const m of sentence.matchAll(re)) {
    if (!evidence.includes(normText(m[0]))) return false;
  }
  return true;
}

/** Keeps only sentences whose risky claims appear in the evidence we actually read. */
function groundStory(story: string, evidenceText: string, fallback: string): string {
  const ev = normText(evidenceText);
  const sentences = (story || "").replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+/g) || (story ? [story] : []);
  const kept = sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && supportedBy(s, ev))
    .filter((s) => !/\b(website|web site|online presence|https?|www\.|url|\.com|could not be (?:read|loaded))\b/i.test(s));
  const out = kept.slice(0, 3).join(" ").trim();
  return out.length >= 30 ? out.slice(0, 480) : fallback;
}

function appearsIn(name: string, evidenceNorm: string): boolean {
  const n = normText(name);
  if (!n) return false;
  if (evidenceNorm.includes(n)) return true;
  const words = n.split(" ").filter((w) => w.length > 2);
  if (words.length >= 2) return evidenceNorm.includes(words.slice(0, 2).join(" "));
  return words.length === 1 && new RegExp(`\\b${words[0].replace(/[.$]/g, "\\$&")}\\b`).test(evidenceNorm);
}

// Curated palettes for businesses whose own colors we couldn't read. Every one is pre-checked
// for legibility and then re-verified by finalizePalette().
export const PALETTES: Record<string, { hint: string; palette: Brand["palette"] }> = {
  terracotta: { hint: "warm clay and cream — Mexican, Mediterranean, taquerias", palette: { primary: "#C4572E", secondary: "#F3E3D3", accent: "#2F5D50", background: "#FBF6EF", text: "#2A1F1A" } },
  chili: { hint: "chili red and marigold — spicy, lively kitchens", palette: { primary: "#B3261E", secondary: "#F6E7DA", accent: "#C98A12", background: "#FFFAF3", text: "#231512" } },
  saffron: { hint: "saffron and deep plum — Indian, Nepalese, spice-forward", palette: { primary: "#B8740A", secondary: "#F7ECD6", accent: "#7A1F3D", background: "#FFFBF2", text: "#241A10" } },
  espresso: { hint: "espresso brown and caramel — coffee shops, bakeries", palette: { primary: "#6B3E26", secondary: "#EFE3D3", accent: "#B7802F", background: "#FAF6F0", text: "#231A15" } },
  washi: { hint: "pine green, paper and vermilion — Japanese, tea, calm cafés", palette: { primary: "#2F4B3E", secondary: "#ECE8DE", accent: "#C8553D", background: "#FAF8F3", text: "#1A1D1B" } },
  sage: { hint: "sage and clay — vegetarian, wellness, plants, florists", palette: { primary: "#56745B", secondary: "#E8EDE4", accent: "#B8683F", background: "#F8F7F2", text: "#1C2420" } },
  citrus: { hint: "tangerine and leaf green — juice, ice cream, sunny counters", palette: { primary: "#D9731A", secondary: "#FFF1DC", accent: "#2E7D5B", background: "#FFFBF4", text: "#1F1A14" } },
  harbor: { hint: "harbor blue and buoy orange — seafood, waterfront, Mission Bay", palette: { primary: "#1F5F8B", secondary: "#E3EEF3", accent: "#D9822B", background: "#F8FBFC", text: "#13232E" } },
  blush: { hint: "raspberry and mint — desserts, bubble tea, sweets", palette: { primary: "#B83E62", secondary: "#FCE8EE", accent: "#3F8F80", background: "#FFF9FA", text: "#2A1A20" } },
  inkbrass: { hint: "navy ink and brass — refined dining, wine, upscale shops", palette: { primary: "#1F2A44", secondary: "#E9E4D8", accent: "#9C7A45", background: "#F7F4EE", text: "#14161B" } },
  workshop: { hint: "slate and safety orange — bike shops, repair, hardware, games", palette: { primary: "#2E4A5A", secondary: "#E6ECEE", accent: "#D26A1E", background: "#F8F9F8", text: "#151B1F" } },
  gallery: { hint: "black, bone and signal red — books, art, design, music", palette: { primary: "#1A1A1A", secondary: "#EEEBE6", accent: "#C8402A", background: "#FAFAF7", text: "#111111" } },
  ballpark: { hint: "ballpark orange on charcoal — sports bars, game-day spots near Oracle Park", palette: { primary: "#F26A21", secondary: "#232326", accent: "#F2C14E", background: "#141416", text: "#F5F2EC" } },
  nightcap: { hint: "low-lit amber and oxblood on near-black — cocktail bars, lounges", palette: { primary: "#E0A04A", secondary: "#221C1E", accent: "#B5403A", background: "#121012", text: "#F4EEE6" } },
};

interface LlmBrand {
  paletteName?: string;
  tagline?: string;
  voice?: string;
  vibe?: string;
  palette?: Partial<Record<keyof Brand["palette"], string>>;
  fonts?: { heading?: string; body?: string };
  keywords?: string[];
  offerings?: { name?: string; description?: string; price?: string }[];
  offeringsFromSite?: boolean;
  story?: string;
}

const CATEGORY_PRESETS: Record<string, { palette: Brand["palette"]; fonts: Brand["fonts"]; vibe: string; voice: string; offerings: { name: string; description: string }[] }> = {
  coffee: {
    palette: { primary: "#7A4A2A", secondary: "#F1E6D8", accent: "#C8873A", background: "#FBF7F1", text: "#221A14" },
    fonts: { heading: "Fraunces", body: "DM Sans" },
    vibe: "warm neighborhood coffee counter",
    voice: "friendly, unfussy, quietly confident",
    offerings: [
      { name: "Espresso drinks", description: "Lattes, cortados and straight shots, pulled to order." },
      { name: "Drip & pour-over", description: "Batch brew for the rush, pour-over when there's a minute." },
      { name: "Pastries", description: "A rotating case of morning bakes." },
    ],
  },
  restaurant: {
    palette: { primary: "#B23A1E", secondary: "#F4E9DC", accent: "#E0A526", background: "#FFFBF5", text: "#1E1612" },
    fonts: { heading: "DM Serif Display", body: "Inter" },
    vibe: "lively neighborhood dining room",
    voice: "generous, direct, a little playful",
    offerings: [
      { name: "Lunch plates", description: "Quick, filling plates for the workday crowd." },
      { name: "Dinner menu", description: "The full kitchen, served into the evening." },
      { name: "Drinks", description: "Something cold to go with it." },
    ],
  },
  bar: {
    palette: { primary: "#E4572E", secondary: "#1D1B22", accent: "#F2C14E", background: "#121116", text: "#F5F1EA" },
    fonts: { heading: "Bebas Neue", body: "Inter" },
    vibe: "low-lit bar with game-night energy",
    voice: "loose, funny, confident",
    offerings: [
      { name: "Cocktails", description: "Classics and house drinks, stirred or shaken." },
      { name: "Draft beer", description: "Local taps alongside the usual suspects." },
      { name: "Bar snacks", description: "Food that holds up to a second round." },
    ],
  },
  sweets: {
    palette: { primary: "#C0476B", secondary: "#FCE8EE", accent: "#6BB7A8", background: "#FFF9FA", text: "#2A1A20" },
    fonts: { heading: "Shrikhand", body: "Nunito" },
    vibe: "bright, cheerful dessert counter",
    voice: "sweet, upbeat, a bit cheeky",
    offerings: [
      { name: "Scoops & treats", description: "Cups, cones and whatever's in the case today." },
      { name: "Drinks", description: "Something cold to carry down the block." },
      { name: "Take-home", description: "Pints and boxes for later." },
    ],
  },
  shop: {
    palette: { primary: "#1F4E5F", secondary: "#EAF0EE", accent: "#D9822B", background: "#FBFBF8", text: "#15191B" },
    fonts: { heading: "Space Grotesk", body: "Inter" },
    vibe: "well-kept independent shop",
    voice: "knowledgeable, helpful, no-nonsense",
    offerings: [
      { name: "In-store selection", description: "Browse what's on the shelves today." },
      { name: "Expert help", description: "Ask the people who run the place." },
      { name: "Special requests", description: "Looking for something specific? Ask at the counter." },
    ],
  },
};

// Category-typical placeholders by cuisine (shown as "Preview — owner to confirm", never priced).
const CUISINE_OFFERINGS: [RegExp, { name: string; description: string }[]][] = [
  [/argentin/, [
    { name: "Empanadas", description: "Baked turnovers with savory fillings, the Argentine counter staple." },
    { name: "Coffee & cortados", description: "Espresso drinks alongside something from the case." },
    { name: "Sweets", description: "Pastries and cookies from the case." },
  ]],
  [/mexican|taco/, [
    { name: "Tacos", description: "Soft tortillas, your pick of fillings, salsa on the side." },
    { name: "Burritos", description: "Rice, beans and a filling, wrapped to go." },
    { name: "Aguas frescas", description: "Cold, fruit-forward drinks." },
  ]],
  [/indian|nepal|himalaya/, [
    { name: "Curries", description: "Slow-simmered sauces, mild to hot." },
    { name: "Tandoor", description: "Breads and grilled dishes from the clay oven." },
    { name: "Rice & sides", description: "Basmati, dal and chutneys to round out the table." },
  ]],
  [/japanese|sushi|ramen/, [
    { name: "Rice bowls", description: "Warm bowls with seasonal toppings." },
    { name: "Tea", description: "Green and roasted teas, hot or iced." },
    { name: "Small plates", description: "Snacks and sides to share." },
  ]],
  [/peruvian/, [
    { name: "Ceviche", description: "Citrus-cured seafood, served cold." },
    { name: "Plates", description: "Hearty Peruvian mains." },
    { name: "Drinks", description: "Cocktails and soft drinks." },
  ]],
  [/mediterranean|greek|lebanese|middle eastern|falafel/, [
    { name: "Wraps", description: "Warm pita, grilled fillings, sauces." },
    { name: "Plates", description: "Rice, salad and a protein on one plate." },
    { name: "Mezze", description: "Dips and small plates to share." },
  ]],
  [/pizza|italian/, [
    { name: "Pizza", description: "By the slice or the whole pie." },
    { name: "Salads", description: "Something green on the side." },
    { name: "Drinks", description: "Soft drinks, beer or wine." },
  ]],
  [/bagel/, [
    { name: "Bagels", description: "Toasted or not, with a spread." },
    { name: "Sandwiches", description: "Bagel sandwiches for the morning rush." },
    { name: "Coffee", description: "Drip and espresso drinks." },
  ]],
  [/bubble tea/, [
    { name: "Milk teas", description: "Classic milk teas with chewy pearls." },
    { name: "Fruit teas", description: "Bright, iced fruit-forward teas." },
    { name: "Toppings", description: "Pearls, jellies and foam." },
  ]],
  [/sandwich|deli/, [
    { name: "Sandwiches", description: "Built to order for lunch." },
    { name: "Salads", description: "A lighter option." },
    { name: "Drinks", description: "Cold drinks from the fridge." },
  ]],
  [/burger|american|bar & grill/, [
    { name: "Burgers", description: "A griddled classic with fries." },
    { name: "Plates", description: "Grill-side mains and sides." },
    { name: "Drinks", description: "Beer, soft drinks and more." },
  ]],
  [/chinese|dim sum|dumpling|thai|vietnam|korean|asian/, [
    { name: "Noodles", description: "Wok-tossed or in broth." },
    { name: "Rice dishes", description: "Stir-fries and rice plates." },
    { name: "Small plates", description: "Dumplings, rolls and sides." },
  ]],
];

function presetFor(biz: Business) {
  const cat = (biz.category || "").toLowerCase();
  const cuisines = cuisineList(biz);
  const cuisineText = cuisines.join(" ").toLowerCase();
  const byCuisine = CUISINE_OFFERINGS.find(([re]) => re.test(cuisineText))?.[1];
  const base = pickPreset(cat, cuisines, biz);
  return byCuisine && isFoodish(biz) ? { ...base, offerings: byCuisine } : base;
}

function pickPreset(cat: string, cuisines: string[], biz: Business) {
  if (cat === "cafe" || cat === "coffee" || cuisines.includes("coffee")) return CATEGORY_PRESETS.coffee;
  if (cat === "bar" || cat === "pub" || cat === "nightclub" || cat === "biergarten") return CATEGORY_PRESETS.bar;
  if (cat === "ice_cream" || cat === "confectionery" || cat === "chocolate" || cat === "pastry" || cat === "bakery") return CATEGORY_PRESETS.sweets;
  if (isFoodish(biz)) return CATEGORY_PRESETS.restaurant;
  return CATEGORY_PRESETS.shop;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function finalizePalette(
  proposed: Partial<Record<keyof Brand["palette"], string>> | undefined,
  ev: SiteEvidence | null,
  preset: Brand["palette"],
  tastePalette?: Partial<Brand["palette"]>,
): Brand["palette"] {
  const pick = (k: keyof Brand["palette"]) => normHex(tastePalette?.[k]) || normHex(proposed?.[k]) || preset[k];
  let primary = pick("primary");
  let secondary = pick("secondary");
  let accent = pick("accent");
  let background = pick("background");
  let text = pick("text");

  // Keep the brand color honest: if the site gave us real brand colors, primary must be one of them.
  const siteChromatic = (ev?.colors || []).filter((c) => brandable(c.hex)).map((c) => c.hex);
  const siteThemeChromatic = ev?.themeColor && brandable(ev.themeColor) ? ev.themeColor : null;
  if (!tastePalette?.primary && siteChromatic.length) {
    const near = siteChromatic.some((c) => colorDistance(c, primary) < 60);
    if (!near) primary = siteThemeChromatic || siteChromatic[0];
  }
  if (!tastePalette?.accent && siteChromatic.length > 1 && !siteChromatic.some((c) => colorDistance(c, accent) < 60)) {
    accent = siteChromatic.find((c) => colorDistance(c, primary) > 90) || accent;
  }

  // Legibility guarantees (deterministic): text on background >= 4.5, text on secondary >= 4.5,
  // primary and accent on background >= 3 (large text / UI).
  const bgDark = luminance(background) < 0.2;
  if (contrast(text, background) < 4.5) {
    const dark = "#171412";
    const light = "#F7F3EC";
    text = contrast(dark, background) >= contrast(light, background) ? dark : light;
    if (contrast(text, background) < 4.5) text = bgDark ? "#FFFFFF" : "#000000";
  }
  if (contrast(text, secondary) < 4.5) {
    // Nudge the surface toward the background so text stays readable on it.
    const [h, s] = rgbToHsl(secondary);
    const [, , lb] = rgbToHsl(background);
    let fixed = secondary;
    for (let i = 1; i <= 20 && contrast(text, fixed) < 4.5; i++) {
      const l = bgDark ? Math.max(0.04, lb + 0.08 - i * 0.004) : Math.min(0.98, 0.86 + i * 0.006);
      fixed = hslToHex(h, Math.min(s, 0.45), l);
    }
    secondary = contrast(text, fixed) >= 4.5 ? fixed : background;
  }
  primary = ensureContrast(primary, background, 3);
  accent = ensureContrast(accent, background, 3);
  if (colorDistance(accent, primary) < 25) accent = ensureContrast(hslToHex(rgbToHsl(primary)[0] + 35, 0.6, bgDark ? 0.65 : 0.45), background, 3);
  return { primary, secondary, accent, background, text };
}

function fallbackStory(biz: Business, env: Env): string {
  const place = placeFor(biz, env);
  const label = categoryLabel(biz);
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  const at = biz.address ? ` at ${biz.address}` : "";
  const hood = place.neighborhood === "San Francisco" ? " in San Francisco" : ` in ${place.neighborhood}, ${place.city}`;
  const near = place.landmark ? `, a short walk from ${place.landmark}` : "";
  return `${biz.name} is ${article} ${label}${at}${hood}${near}.`;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((r) => (t = setTimeout(() => r(null), ms)))]);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface BrandResult {
  brand: Brand;
  costCents: number;
  provider: string; // model that wrote the brand, or "heuristic" if every model was unavailable
  signals: string[]; // evidence actually read (same as brand.sourceSignals)
}

export async function extractBrand(env: Env, biz: Business): Promise<BrandResult> {
  const signals: string[] = [];
  let costCents = 0;
  let provider = "heuristic";
  const preset = presetFor(biz);
  const place = placeFor(biz, env);
  const cuisines = cuisineList(biz);
  const label = categoryLabel(biz);

  // 1) Taste Labs brand kit (optional, never fatal) and 2) our own read of the site, in parallel.
  let tasteOn = false;
  try {
    tasteOn = !!biz.website && tasteEnabled(env);
  } catch {
    tasteOn = false;
  }
  const [taste, ev] = await Promise.all([
    tasteOn ? withTimeout(tasteExtractBrand(env, biz.website as string, { waitMs: 20_000 }), 22_000) : Promise.resolve(null),
    biz.website ? readWebsite(biz.website).catch(() => null) : Promise.resolve(null),
  ]);
  if (taste) signals.push("Taste Labs brand extraction");

  if (biz.website) {
    if (ev) {
      const host = (() => {
        try {
          return new URL(ev.finalUrl).host.replace(/^www\./, "");
        } catch {
          return biz.website;
        }
      })();
      if (ev.title) signals.push(`website title "${ev.title.slice(0, 70)}"`);
      if (ev.description || ev.ogDescription) signals.push("meta description");
      if (ev.themeColor) signals.push(`theme-color ${ev.themeColor}`);
      const chromatic = ev.colors.filter((c) => brandable(c.hex));
      if (chromatic.length) signals.push(`CSS colors ${chromatic.slice(0, 3).map((c) => c.hex).join(" ")}`);
      if (ev.googleFonts.length) signals.push(`Google Fonts: ${ev.googleFonts.slice(0, 3).join(", ")}`);
      else if (ev.cssFonts.length) signals.push(`CSS fonts: ${ev.cssFonts.slice(0, 2).join(", ")}`);
      if (ev.headings.length) signals.push(`${ev.headings.length} headings`);
      if (ev.text.length > 200) signals.push(`${ev.text.length} chars of page text from ${host}`);
      if (ev.prices.length) signals.push(`${ev.prices.length} prices on site`);
      if (ev.ogImage) signals.push("og:image");
    } else {
      signals.push(`website ${biz.website} could not be read`);
    }
  }
  evidenceCache.set(biz.id, ev);

  // OSM facts we actually have.
  const t = biz.osmTags || {};
  if (t["cuisine"]) signals.push(`OSM cuisine=${t["cuisine"]}`);
  signals.push(`OSM category=${biz.category}`);
  if (biz.openingHours) signals.push("OSM opening_hours");
  if (biz.address) signals.push("OSM address");
  for (const k of ["outdoor_seating", "takeaway", "delivery", "diet:vegan", "diet:vegetarian", "wheelchair", "reservation"]) {
    if (t[k]) signals.push(`OSM ${k}=${t[k]}`);
  }

  const osmFacts: Record<string, string> = {};
  for (const k of [
    "cuisine", "outdoor_seating", "indoor_seating", "takeaway", "delivery", "reservation", "diet:vegan",
    "diet:vegetarian", "wheelchair", "level", "contact:instagram", "instagram", "description", "brewery",
    "drink:coffee", "sport", "craft", "shop", "amenity",
  ]) {
    if (t[k]) osmFacts[k] = t[k];
  }

  const evidenceBlock = ev
    ? `WEBSITE EVIDENCE (fetched just now from ${ev.finalUrl}):
- <title>: ${ev.title ?? "(none)"}
- meta description: ${ev.description ?? ev.ogDescription ?? "(none)"}
- og:title: ${ev.ogTitle ?? "(none)"}; og:site_name: ${ev.siteName ?? "(none)"}
- theme-color: ${ev.themeColor ?? "(none)"}
- most frequent CSS colors (hex x count): ${ev.colors.slice(0, 12).map((c) => `${c.hex}x${c.count}`).join(", ") || "(none found)"}
- Google Fonts loaded: ${ev.googleFonts.join(", ") || "(none)"}; other CSS font-families: ${ev.cssFonts.join(", ") || "(none)"}
- headings: ${ev.headings.map((h) => `"${h}"`).join(" | ") || "(none)"}
- prices seen: ${ev.prices.join(" ") || "(none)"}
- visible page text (first 3000 chars):
"""
${ev.text || "(page had almost no readable text — it is probably rendered with JavaScript)"}
"""`
    : biz.website
      ? `WEBSITE: ${biz.website} exists but could not be read right now. Do NOT pretend you read it.`
      : "WEBSITE: none known.";

  const tasteBlock = taste
    ? `\nTASTE LABS BRAND KIT (trusted design extraction; prefer its palette and fonts):\n${JSON.stringify(taste).slice(0, 1500)}`
    : "";

  const system = `You are Archivist, the brand researcher at Cold Open, an agency that builds a site for a local business before asking for anything.
You extract a small business's REAL brand from evidence. You never invent facts: no founding years, owners' names, awards, reviews, ratings, "family-owned", "since", signature dishes or prices unless the evidence states them.
You write like a sharp editor: concrete nouns, no marketing clichés.`;

  const prompt = `BUSINESS (from OpenStreetMap):
- name: ${biz.name}
- what it is: ${label}${cuisines.length ? ` (cuisine tags: ${cuisines.join(", ")})` : ""}
- address: ${biz.address ?? "(unknown)"}
- neighborhood: ${place.phrase}
- opening hours (OSM syntax): ${biz.openingHours ?? "(unknown)"}
- other OSM tags: ${JSON.stringify(osmFacts)}

${evidenceBlock}${tasteBlock}

Return this JSON object:
{
  "tagline": "max 9 words, specific to this place (what they serve/do + where or how), no clichés",
  "voice": "3-5 comma-separated adjectives for how this business talks",
  "vibe": "short phrase for the look & feel, e.g. 'sunlit Argentinian corner café'",
  ${ev && ev.colors.some((c) => brandable(c.hex)) ? "" : '"paletteName": "one of the curated palette names below",\n  '}"palette": { "primary": "#RRGGBB", "secondary": "#RRGGBB", "accent": "#RRGGBB", "background": "#RRGGBB", "text": "#RRGGBB" },
  "fonts": { "heading": "Google Fonts family", "body": "Google Fonts family" },
  "keywords": ["4-8 concrete words: dishes, materials, streets, mood"],
  "offerings": [{ "name": "item or service", "description": "max 16 words", "price": "only if that exact price appears in the evidence, else omit" }],
  "offeringsFromSite": true,
  "story": "2-3 factual sentences"
}

RULES
- palette: primary = the brand's signature color (buttons, key accents); secondary = a soft surface/band color that body text sits on; accent = a small highlight color; background = page background; text = body text color. ${ev && ev.colors.some((c) => brandable(c.hex)) ? "Primary MUST be taken from the site's own CSS colors or theme-color above (ignore pure black/white/greys for primary). Use a light background unless the evidence clearly shows a dark brand." : `We couldn't read their colors, so pick the curated palette that best fits the category, cuisine, name and neighborhood, set "paletteName" to it and copy its hexes into "palette":
${Object.entries(PALETTES).map(([k, v]) => `    ${k}: ${v.hint} (${v.palette.primary} / ${v.palette.accent} on ${v.palette.background})`).join("\n")}`}
- fonts: pick from this list only: ${FONT_ALLOWLIST.join(", ")}${ev?.googleFonts.length ? `, or the Google Fonts the site already loads (${ev.googleFonts.join(", ")}) — prefer those.` : "."}
- offerings: 3-6 items. If the website text names real menu items/services, use those exact names (and prices only if shown) and set "offeringsFromSite": true. Otherwise set it false and describe honest category-typical offerings with generic names (e.g. "Espresso drinks", "Lunch plates") and NO prices.
- story: only facts supported above (what it is, where, what the site says about itself). If the evidence is thin, describe what and where plainly, e.g. "${fallbackStory(biz, env)}" Never invent history, people, awards or reviews.
- Banned words and phrases anywhere: elevate, unleash, nestled, culinary journey, tantalize, mouthwatering, look no further, in the heart of, whether you're, embark, delve, symphony of flavors, testament, haven, seamless, unparalleled, world-class, best-kept secret, hidden gem, indulge, curated, vibrant.`;

  let out: LlmBrand = {};
  try {
    const res = await llmJSON<LlmBrand>(env, { system, prompt, maxTokens: 1600, temperature: 0.4, effort: "low" });
    costCents += res.costCents;
    provider = res.provider;
    out = res.data || {};
  } catch (e) {
    console.warn(`[brand] LLM failed for ${biz.id}: ${e instanceof Error ? e.message : e}`);
    signals.push("brand model unavailable — category defaults used");
    out = {};
  }

  // ---- deterministic validation ----------------------------------------------------------
  const evidenceAll = [ev?.title, ev?.description, ev?.ogDescription, ev?.ogTitle, ...(ev?.headings || []), ev?.text].filter(Boolean).join("\n");
  const evidenceNorm = normText(evidenceAll);
  const siteReadable = !!ev && ev.text.length > 120;

  const siteHasColors = !!ev && ev.colors.some((c) => brandable(c.hex));
  const curatedKey = typeof out.paletteName === "string" ? out.paletteName.toLowerCase().replace(/[^a-z]/g, "") : "";
  const curated = !siteHasColors && PALETTES[curatedKey] ? PALETTES[curatedKey].palette : null;
  if (curated) signals.push(`curated palette "${curatedKey}" (site colors unavailable)`);
  const palette = finalizePalette(curated ?? out.palette, ev, curated ?? preset.palette, taste?.palette);

  const siteFonts = ev?.googleFonts || [];
  const headingFont = resolveFont(taste?.fonts?.heading || out.fonts?.heading || siteFonts[0] || preset.fonts.heading, "heading", siteFonts);
  let bodyFont = resolveFont(taste?.fonts?.body || out.fonts?.body || siteFonts[1] || preset.fonts.body, "body", siteFonts);
  if (bodyFont === headingFont && /Bebas Neue|Anton|Abril Fatface|Shrikhand|Pacifico|Permanent Marker|Caveat|Alfa Slab One|Big Shoulders Display|Archivo Black|Unbounded/.test(bodyFont)) {
    bodyFont = "Inter"; // display faces are not body faces
  }

  // Offerings: confirmed only if every kept item is actually named in the site text.
  const rawOfferings = (Array.isArray(out.offerings) ? out.offerings : [])
    .map((o) => ({ name: str(o?.name, 60), description: str(o?.description, 140), price: str(o?.price, 16) }))
    .filter((o) => o.name.length > 1);
  let offeringsConfirmed = false;
  let offerings: Brand["offerings"];
  const merch = /\b(tee|t-shirt|shirt|hoodie|sweatshirt|hat|cap|beanie|tote|mug|tumbler|sticker|gift ?card|merch(andise)?|apparel|onesie|baby)\b/i;
  const fromSite =
    siteReadable && out.offeringsFromSite === true
      ? rawOfferings.filter((o) => appearsIn(o.name, evidenceNorm) && !(isFoodish(biz) && merch.test(o.name)))
      : [];
  if (fromSite.length >= 3) {
    offeringsConfirmed = true;
    offerings = fromSite.slice(0, 6).map((o) => {
      const priceKey = (x: string) => x.replace(/[^0-9.]/g, "").replace(/\.00$/, "");
      const price = o.price && /\d/.test(o.price) && (ev?.prices || []).some((p) => priceKey(p) === priceKey(o.price)) ? o.price : undefined;
      return price ? { name: o.name, description: o.description, price: price.startsWith("$") ? price : `$${price}` } : { name: o.name, description: o.description };
    });
    signals.push(`${offerings.length} offerings named on site`);
  } else {
    offerings = rawOfferings.slice(0, 6).map((o) => ({ name: o.name, description: o.description }));
    if (offerings.length < 3) {
      for (const p of preset.offerings) if (offerings.length < 3 && !offerings.some((o) => o.name === p.name)) offerings.push({ ...p });
    }
  }

  // Without their own words to ground it, the story is the plain facts — nothing inferred.
  const story = siteReadable ? groundStory(str(out.story, 600), evidenceAll, fallbackStory(biz, env)) : fallbackStory(biz, env);
  const streetName = (biz.address || "").replace(/^\d+[A-Za-z]?\s+/, "").split(",")[0].trim();
  const tagline =
    str(taste?.tagline || out.tagline, 90).replace(/^["“]|["”]$/g, "") ||
    `${label.charAt(0).toUpperCase()}${label.slice(1)} ${streetName ? `on ${streetName}` : `in ${place.neighborhood}`}`;
  const keywords = Array.from(
    new Set(
      [...(Array.isArray(taste?.keywords) ? taste!.keywords! : []), ...(Array.isArray(out.keywords) ? out.keywords : [])]
        .map((k) => str(k, 28).toLowerCase())
        .filter((k) => k.length > 1),
    ),
  ).slice(0, 8);
  if (keywords.length < 3) {
    for (const k of [...cuisines.map((c) => c.toLowerCase()), place.neighborhood.toLowerCase(), label.toLowerCase()]) if (!keywords.includes(k) && keywords.length < 5) keywords.push(k);
  }

  const sourceSignals = Array.from(new Set(signals)).slice(0, 14);
  const brand: Brand = {
    name: biz.name,
    tagline,
    voice: str(taste?.voice || out.voice, 80) || preset.voice,
    vibe: str(taste?.vibe || out.vibe, 90) || preset.vibe,
    palette,
    fonts: { heading: headingFont, body: bodyFont },
    keywords,
    offerings,
    offeringsConfirmed,
    story,
    sourceSignals,
  };
  return { brand, costCents: Math.round(costCents * 10000) / 10000, provider, signals: sourceSignals };
}
