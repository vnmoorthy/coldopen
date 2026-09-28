// Scratch sanity check for the Scout query (same QL + mirrors as src/pipeline/scout.ts).
// Usage: node scripts/scratch-scout.mjs [lat] [lon] [radius] [nameQuery]
// (Mirrors are tried strictly in order here; the Worker also hedges a slow mirror after 4.5s.)
const lat = Number(process.argv[2] ?? 37.7786);
const lon = Number(process.argv[3] ?? -122.3893);
const radius = Number(process.argv[4] ?? 450);
const nameQuery = process.argv[5] ?? "";

const MIRRORS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const UA = "ColdOpen/1.0 (hackathon demo)";

const around = `around:${radius},${lat},${lon}`;
const nearbyQL = `[out:json][timeout:25];
(
  nwr(${around})["name"]["amenity"~"^(cafe|restaurant|bar|fast_food|pub|ice_cream|bakery)$"];
  nwr(${around})["name"]["shop"];
  nwr(${around})["name"]["craft"];
);
out center tags;`;

function nameRegex(name) {
  return name.trim().replace(/[^\p{L}\p{N} ]/gu, ".").replace(/\s+/g, " ");
}
const byNameQL = `[out:json][timeout:25];
nwr(around:1500,${lat},${lon})["name"~"${nameRegex(nameQuery)}",i];
out center tags;`;

async function run(ql) {
  for (const url of MIRRORS) {
    const t0 = Date.now();
    try {
      // GET, like src/pipeline/scout.ts: the maps.mail.ru mirror hangs on POST bodies.
      const res = await fetch(`${url}?data=${encodeURIComponent(ql)}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      if (!res.ok) { console.log(`${url} -> HTTP ${res.status} (${Date.now() - t0}ms)`); continue; }
      const json = JSON.parse(text);
      console.log(`${url} -> ${json.elements?.length ?? 0} elements (${Date.now() - t0}ms)`);
      return json.elements ?? [];
    } catch (e) {
      console.log(`${url} -> ${e.message} (${Date.now() - t0}ms)`);
    }
  }
  return [];
}

const els = await run(nameQuery ? byNameQL : nearbyQL);
const rows = els.map((e) => {
  const t = e.tags ?? {};
  const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon;
  return {
    osmId: `${e.type}/${e.id}`,
    name: t.name,
    category: t.amenity || t.shop || t.craft || "?",
    cuisine: t.cuisine,
    chain: !!(t.brand || t["brand:wikidata"]),
    website: t.website || t["contact:website"] || t.url || null,
    address: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") || null,
    hours: t.opening_hours || null,
    dist: Math.round(Math.hypot((la - lat) * 111320, (lo - lon) * 111320 * Math.cos((lat * Math.PI) / 180))),
  };
});
rows.sort((a, b) => Number(a.chain) - Number(b.chain) || Number(!a.website) - Number(!b.website) || a.dist - b.dist);
console.table(rows.slice(0, 40));
console.log(`total=${rows.length} chains=${rows.filter((r) => r.chain).length} withWebsite=${rows.filter((r) => r.website).length}`);
