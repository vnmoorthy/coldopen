import SNAPSHOT from "./osm-snapshot.json";
// Scout: finds real independent businesses around a point via OpenStreetMap Overpass.
// No keys needed. Mirrors are tried in order with a hedge (a slow mirror does not block the demo).

export interface ScoutedPlace {
  osmId: string; // "node/123" | "way/456" | "relation/789"
  name: string;
  category: string; // amenity | shop | craft value, e.g. "cafe", "restaurant", "books"
  lat: number;
  lon: number;
  address: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  openingHours: string | null;
  osmTags: Record<string, string>;
}

export const OVERPASS_MIRRORS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const UA = "ColdOpen/1.0 (hackathon demo)";
const MIRROR_TIMEOUT_MS = 20_000;
const HEDGE_DELAY_MS = 4_500; // start the next mirror if the current one is still silent

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// National / international chains that often lack brand tags in OSM.
const KNOWN_CHAINS = [
  "starbucks", "peet's", "peets", "blue bottle", "philz", "dunkin", "tim hortons", "costa coffee",
  "mcdonald", "burger king", "wendy", "taco bell", "chipotle", "subway", "jersey mike", "jimmy john",
  "earl of sandwich", "potbelly", "panera", "pret a manger", "sweetgreen", "cava", "chick-fil-a",
  "shake shack", "in-n-out", "five guys", "panda express", "domino", "pizza hut", "papa john",
  "little caesars", "round table", "mountain mike", "kfc", "popeyes", "jack in the box", "carl's jr",
  "wingstop", "buffalo wild wings", "applebee", "chili's", "olive garden", "cheesecake factory",
  "p.f. chang", "noah's", "einstein bros", "jamba", "boba guys", "gong cha", "kung fu tea", "tiger sugar",
  "krispy kreme", "baskin", "cold stone", "ben & jerry", "häagen", "haagen", "yogurtland", "pinkberry",
  "mendocino farms", "tender greens", "specialty's", "proper food", "la boulangerie", "super duper",
  "walgreens", "cvs", "rite aid", "7-eleven", "7 eleven", "safeway", "whole foods", "trader joe",
  "target", "walmart", "costco", "best buy", "apple store", "t-mobile", "at&t", "verizon", "sprint",
  "ups store", "fedex", "supercuts", "great clips", "sport clips", "european wax", "drybar",
  "orangetheory", "equinox", "24 hour fitness", "planet fitness", "crunch fitness", "soulcycle",
  "chase", "wells fargo", "bank of america", "citibank", "us bank", "lululemon", "nike", "gap",
  "old navy", "banana republic", "uniqlo", "h&m", "zara", "sephora", "ulta", "petco", "petsmart",
  "office depot", "staples", "michaels", "marshalls", "tj maxx", "ross dress", "dollar tree",
  "giants dugout", "amc", "regal", "hertz", "enterprise", "avis", "mattress firm", "sleep number",
];

const GENERIC_NAMES = new Set([
  "cafe", "café", "restaurant", "bar", "pub", "bakery", "shop", "store", "market", "deli", "kiosk",
  "coffee", "food truck", "parking", "vacant", "atm", "office", "unknown", "test",
]);

const SKIP_SHOP_VALUES = new Set(["vacant", "no", "none", "disused", "yes;vacant", "kiosk"]);

function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’'`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isChain(tags: Record<string, string>): boolean {
  if (tags["brand"] || tags["brand:wikidata"] || tags["brand:wikipedia"] || tags["operator:wikidata"]) return true;
  const n = normName(tags["name"] || "");
  return KNOWN_CHAINS.some((c) => {
    const cn = normName(c);
    if (n === cn || n.startsWith(cn + " ") || n.startsWith(cn + "'")) return true;
    // Multi-word chain names are distinctive enough to match mid-name ("SFO Blue Bottle").
    return cn.includes(" ") && (n.includes(" " + cn + " ") || n.endsWith(" " + cn) || n.includes(" " + cn + "'"));
  });
}

function usableName(name: string | undefined): name is string {
  if (!name) return false;
  const t = name.trim();
  if (t.length < 2 || t.length > 80) return false;
  if (!/\p{L}/u.test(t)) return false; // purely numeric / symbols
  if (GENERIC_NAMES.has(normName(t))) return false;
  return true;
}

export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function cleanUrl(u: string | undefined): string | null {
  if (!u) return null;
  let s = u.trim().split(/[;\s]/)[0];
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[\w-]+(\.[\w-]+)+/.test(s)) s = "https://" + s;
    else return null;
  }
  try {
    const url = new URL(s);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function firstOf(tags: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = tags[k];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function toPlace(el: OverpassElement): ScoutedPlace | null {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const name = tags["name"];
  if (!usableName(name)) return null;
  const category =
    tags["amenity"] || tags["shop"] || tags["craft"] || tags["office"] || tags["tourism"] || tags["leisure"] || tags["healthcare"] || "business";
  const street = tags["addr:street"];
  const house = tags["addr:housenumber"];
  const address = street ? [house, street].filter(Boolean).join(" ") + (tags["addr:unit"] ? `, Unit ${tags["addr:unit"]}` : "") : null;
  const email = firstOf(tags, ["email", "contact:email"]);
  // Keep useful tags; drop translations and bookkeeping noise.
  const osmTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (/^(name:|old_name|alt_name:|source|check_date|survey|note|fixme|wikidata|wikipedia)/i.test(k)) continue;
    if (Object.keys(osmTags).length >= 40) break;
    osmTags[k] = String(v).slice(0, 300);
  }
  return {
    osmId: `${el.type}/${el.id}`,
    name: name.trim(),
    category: category.split(";")[0].trim(),
    lat,
    lon,
    address,
    website: cleanUrl(firstOf(tags, ["website", "contact:website", "url"]) ?? undefined),
    phone: firstOf(tags, ["phone", "contact:phone"]),
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.split(";")[0].trim()) ? email.split(";")[0].trim() : null,
    openingHours: firstOf(tags, ["opening_hours"]),
    osmTags,
  };
}

/** Runs an Overpass query against the mirror chain. Mirrors are tried in order; if one is slow,
 *  the next is started after a short hedge delay and the first valid JSON response wins. */
export async function overpass(ql: string): Promise<OverpassElement[]> {
  const errors: string[] = [];
  const controllers: AbortController[] = [];
  return await new Promise<OverpassElement[]>((resolve, reject) => {
    let settled = false;
    let started = 0;
    let finished = 0;
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

    const done = (els: OverpassElement[]) => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      for (const c of controllers) {
        try { c.abort(); } catch { /* ignore */ }
      }
      resolve(els);
    };
    const fail = () => {
      if (settled) return;
      if (finished >= OVERPASS_MIRRORS.length) {
        settled = true;
        if (hedgeTimer) clearTimeout(hedgeTimer);
        reject(new Error("All Overpass mirrors failed: " + errors.join(" | ")));
      }
    };
    const startNext = () => {
      if (settled || started >= OVERPASS_MIRRORS.length) return;
      const idx = started++;
      const base = OVERPASS_MIRRORS[idx];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), MIRROR_TIMEOUT_MS);
      if (hedgeTimer) clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(startNext, HEDGE_DELAY_MS);
      (async () => {
        try {
          const res = await fetch(`${base}?data=${encodeURIComponent(ql)}`, {
            method: "GET",
            headers: { "User-Agent": UA, Accept: "application/json" },
            signal: ctrl.signal,
          });
          const text = await res.text();
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          let json: { elements?: OverpassElement[]; remark?: string };
          try {
            json = JSON.parse(text);
          } catch {
            throw new Error("non-JSON response");
          }
          if (!Array.isArray(json.elements)) throw new Error("no elements");
          if (json.elements.length === 0 && json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) {
            throw new Error(json.remark.slice(0, 120));
          }
          done(json.elements);
        } catch (e) {
          if (!settled) {
            errors.push(`${new URL(base).host}: ${e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e)}`);
          }
          finished++;
          // A failure means we should not wait for the hedge delay.
          startNext();
          fail();
        } finally {
          clearTimeout(timer);
        }
      })();
    };
    startNext();
  });
}

function snapshotAround(lat: number, lon: number, radius: number): OverpassElement[] {
  const els = (SNAPSHOT as unknown as { elements: OverpassElement[] }).elements || [];
  return els.filter((el) => {
    const c = (el as { center?: { lat: number; lon: number } }).center;
    const la = (el as { lat?: number }).lat ?? c?.lat;
    const lo = (el as { lon?: number }).lon ?? c?.lon;
    return typeof la === "number" && typeof lo === "number" && distanceMeters(lat, lon, la, lo) <= radius;
  });
}

function sortPlaces(places: ScoutedPlace[], lat: number, lon: number): ScoutedPlace[] {
  return places
    .map((p) => ({ p, d: distanceMeters(lat, lon, p.lat, p.lon) }))
    .sort((a, b) => Number(!a.p.website) - Number(!b.p.website) || a.d - b.d)
    .map((x) => x.p);
}

/** Independent businesses near (lat, lon). Chains skipped, deduped by name, websites first then distance. */
export async function scoutNearby(lat: number, lon: number, radius = 450, limit = 24): Promise<ScoutedPlace[]> {
  const r = Math.max(50, Math.min(3000, Math.round(radius)));
  const around = `around:${r},${lat},${lon}`;
  const ql = `[out:json][timeout:25];
(
  nwr(${around})["name"]["amenity"~"^(cafe|restaurant|bar|fast_food|pub|ice_cream|bakery)$"];
  nwr(${around})["name"]["shop"];
  nwr(${around})["name"]["craft"];
);
out center tags;`;
  const t0 = Date.now();
  let elements: OverpassElement[];
  try {
    elements = await overpass(ql);
  } catch (e) {
    // Public mirrors shed load with fast 429/504s; one short retry round usually lands.
    try {
      if (Date.now() - t0 > 20_000) throw e;
      await new Promise((r) => setTimeout(r, 1500));
      elements = await overpass(ql);
    } catch (e2) {
      // Every public mirror is down: fall back to the OSM snapshot captured around HQ today,
      // so a stage demo never depends on a volunteer-run server. Same data, same filters.
      elements = snapshotAround(lat, lon, r);
      if (!elements.length) throw e2;
      console.warn(`[scout] Overpass unavailable, using OSM snapshot (${elements.length} elements)`);
    }
  }
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  const places: ScoutedPlace[] = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags["shop"] && SKIP_SHOP_VALUES.has(tags["shop"])) continue;
    if (tags["disused:shop"] || tags["disused:amenity"] || tags["opening_hours"] === "closed") continue;
    if (isChain(tags)) continue;
    const p = toPlace(el);
    if (!p) continue;
    const key = normName(p.name);
    if (seenNames.has(key) || seenIds.has(p.osmId)) continue;
    seenNames.add(key);
    seenIds.add(p.osmId);
    places.push(p);
  }
  return sortPlaces(places, lat, lon).slice(0, Math.max(1, Math.min(200, limit)));
}

const FOLD: Record<string, string> = {
  a: "aáàâäãåAÁÀÂÄÃÅ", e: "eéèêëEÉÈÊË", i: "iíìîïIÍÌÎÏ", o: "oóòôöõøOÓÒÔÖÕØ", u: "uúùûüUÚÙÛÜ",
  n: "nñNÑ", c: "cçCÇ", y: "yýÿYÝ",
};

/** Overpass-safe, case- and accent-insensitive pattern: letters with accented variants become a
 *  character class, every other non letter/digit/space char becomes "." (so Momo's matches Momo’s). */
function namePattern(name: string): string {
  const base = name.trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").slice(0, 60);
  let out = "";
  for (const ch of base) {
    const lower = ch.toLowerCase();
    if (FOLD[lower]) out += `[${FOLD[lower]}]`;
    else if (/[\p{L}\p{N}]/u.test(ch)) out += ch;
    else if (/\s/.test(ch)) out += out.endsWith(" ") ? "" : " ";
    else out += ".";
  }
  return out.trim();
}

interface NominatimHit {
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  category?: string;
  type?: string;
  name?: string;
  address?: Record<string, string>;
  extratags?: Record<string, string> | null;
}

const BUSINESS_CLASSES = new Set(["amenity", "shop", "craft", "office", "tourism", "leisure", "healthcare"]);

/** Nominatim: one fast, accent-insensitive request. Used first for name lookups. */
async function nominatimFind(name: string, lat: number, lon: number): Promise<ScoutedPlace[]> {
  const dLat = 1500 / 111320;
  const dLon = 1500 / (111320 * Math.cos((lat * Math.PI) / 180));
  const params = new URLSearchParams({
    q: name,
    format: "jsonv2",
    extratags: "1",
    addressdetails: "1",
    limit: "10",
    bounded: "1",
    viewbox: `${lon - dLon},${lat + dLat},${lon + dLon},${lat - dLat}`,
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { "User-Agent": UA, Accept: "application/json", "Accept-Language": "en" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`nominatim HTTP ${res.status}`);
  const hits = (await res.json()) as NominatimHit[];
  const out: ScoutedPlace[] = [];
  for (const h of Array.isArray(hits) ? hits : []) {
    if (!h.category || !BUSINESS_CLASSES.has(h.category) || !h.type || !h.osm_type || !h.osm_id) continue;
    const tags: Record<string, string> = { ...(h.extratags || {}) };
    tags[h.category] = h.type;
    if (h.name) tags["name"] = h.name;
    const a = h.address || {};
    if (a["house_number"]) tags["addr:housenumber"] = a["house_number"];
    if (a["road"]) tags["addr:street"] = a["road"];
    if (a["postcode"]) tags["addr:postcode"] = a["postcode"];
    if (a["city"]) tags["addr:city"] = a["city"];
    if (a["neighbourhood"] || a["suburb"]) tags["nominatim:neighbourhood"] = a["neighbourhood"] || a["suburb"];
    const p = toPlace({
      type: h.osm_type as OverpassElement["type"],
      id: h.osm_id,
      lat: Number(h.lat),
      lon: Number(h.lon),
      tags,
    });
    if (p) out.push(p);
  }
  return out;
}

async function overpassFind(name: string, lat: number, lon: number): Promise<ScoutedPlace[]> {
  const pattern = namePattern(name);
  if (pattern.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return [];
  const around = `around:1500,${lat},${lon}`;
  const ql = `[out:json][timeout:25];
(
  nwr(${around})["amenity"]["name"~"${pattern}",i];
  nwr(${around})["shop"]["name"~"${pattern}",i];
  nwr(${around})["craft"]["name"~"${pattern}",i];
  nwr(${around})["office"]["name"~"${pattern}",i];
  nwr(${around})["tourism"]["name"~"${pattern}",i];
  nwr(${around})["leisure"]["name"~"${pattern}",i];
);
out center tags;`;
  const elements = await overpass(ql);
  return elements.map(toPlace).filter((p): p is ScoutedPlace => !!p);
}

/** Best OSM match for a business name within 1.5 km of (lat, lon), or null. Tries Nominatim
 *  (fast, accent-insensitive), then the Overpass mirror chain. Chains are allowed here because the
 *  user asked for this business by name. */
export async function findByName(name: string, lat: number, lon: number): Promise<ScoutedPlace | null> {
  const q = name.trim().slice(0, 100);
  if (q.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return null;
  let candidates: ScoutedPlace[] = [];
  try {
    candidates = await nominatimFind(q, lat, lon);
  } catch {
    candidates = [];
  }
  if (!candidates.length) {
    try {
      candidates = await overpassFind(q, lat, lon);
    } catch {
      candidates = [];
    }
  }
  const target = normName(q);
  const ranked = candidates
    .map((p) => {
      const n = normName(p.name);
      const rank = n === target ? 0 : n.startsWith(target) || target.startsWith(n) ? 1 : n.includes(target) ? 2 : 3;
      return { p, rank, d: distanceMeters(lat, lon, p.lat, p.lon) };
    })
    .filter((x) => x.d <= 1600)
    .sort((a, b) => a.rank - b.rank || Number(!a.p.website) - Number(!b.p.website) || a.d - b.d);
  return ranked[0]?.p ?? null;
}
