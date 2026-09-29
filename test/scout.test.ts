import { describe, expect, it } from "vitest";
import SNAPSHOT from "../src/pipeline/osm-snapshot.json";
import { OVERPASS_MIRRORS, distanceMeters, findByName, scoutNearby } from "../src/pipeline/scout";
import { HQ, jsonResponse, stubFetch } from "./fixtures";

describe("distanceMeters (haversine)", () => {
  it("is zero for the same point", () => {
    expect(distanceMeters(HQ.lat, HQ.lon, HQ.lat, HQ.lon)).toBe(0);
  });

  it("measures one degree of latitude as ~111.2 km", () => {
    expect(Math.abs(distanceMeters(0, 0, 1, 0) - 111_195)).toBeLessThan(1);
  });

  it("shrinks longitude degrees with latitude (cos 60° = 0.5)", () => {
    const atEquator = distanceMeters(0, 0, 0, 1);
    const at60 = distanceMeters(60, 0, 60, 1);
    expect(at60 / atEquator).toBeCloseTo(0.5, 2);
  });

  it("is symmetric", () => {
    const a = distanceMeters(37.7786, -122.3893, 37.7749, -122.4194);
    const b = distanceMeters(37.7749, -122.4194, 37.7786, -122.3893);
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeGreaterThan(2_500);
    expect(a).toBeLessThan(2_900);
  });
});

// A tiny, fictional Overpass response that exercises every filter in scoutNearby().
function el(id: number, tags: Record<string, string>, dLat = 0, dLon = 0) {
  return { type: "node", id, lat: HQ.lat + dLat, lon: HQ.lon + dLon, tags };
}

const FIXTURE = {
  elements: [
    el(1, { name: "Harbor Lane Coffee", amenity: "cafe", website: "harborlane.example", "addr:housenumber": "123", "addr:street": "Example Street", "addr:unit": "B", email: "hi@harborlane.example", "name:es": "Café", check_date: "2026-01-01" }, 0.001),
    el(2, { name: "Harbor Lane Coffee", amenity: "cafe" }, 0.002), // duplicate name
    el(3, { name: "Starbucks Reserve", amenity: "cafe" }), // known chain (prefix)
    el(4, { name: "SFO Blue Bottle", amenity: "cafe" }), // multi-word chain mid-name
    el(5, { name: "Peet's Coffee", amenity: "cafe" }), // chain with apostrophe
    el(6, { name: "Corner Roasters", amenity: "cafe", brand: "Corner Roasters" }), // brand tag = chain
    el(7, { name: "Cafe", amenity: "cafe" }), // generic name
    el(8, { name: "Empty Unit", shop: "vacant" }), // vacant shop
    el(9, { name: "Old Records", shop: "music", "disused:shop": "music" }), // disused
    el(10, { name: "Gone Bar", amenity: "bar", opening_hours: "closed" }), // closed
    el(11, { name: "12345", shop: "books" }), // no letters
    el(12, { name: "Subwayside Books", shop: "books" }, 0.0005), // must NOT be mistaken for "Subway"
    el(13, { name: "Targeted Fitness Gear", shop: "sports" }, 0.0015), // must NOT be mistaken for "Target"
    { type: "way", id: 14, center: { lat: HQ.lat + 0.0003, lon: HQ.lon }, tags: { name: "Dock Street Deli", shop: "deli", website: "https://dock.example/menu" } },
    { type: "node", id: 15, tags: { name: "No Coordinates", shop: "books" } },
    el(16, { name: "Bad Email Books", shop: "books", email: "not-an-email" }, 0.004),
  ],
};

describe("scoutNearby filtering (stubbed Overpass)", () => {
  it("keeps independent businesses and drops chains, generic names, vacant/closed places and duplicates", async () => {
    const { calls } = stubFetch(() => jsonResponse(FIXTURE));
    const places = await scoutNearby(HQ.lat, HQ.lon, 450, 24);
    expect(calls[0].url.startsWith(OVERPASS_MIRRORS[0])).toBe(true);
    expect(places.map((p) => p.name)).toEqual([
      // websites first (nearest first), then the rest by distance
      "Dock Street Deli",
      "Harbor Lane Coffee",
      "Subwayside Books",
      "Targeted Fitness Gear",
      "Bad Email Books",
    ]);
  });

  it("normalizes each place (address, website, email, tags, ids)", async () => {
    stubFetch(() => jsonResponse(FIXTURE));
    const places = await scoutNearby(HQ.lat, HQ.lon);
    const harbor = places.find((p) => p.name === "Harbor Lane Coffee")!;
    expect(harbor.osmId).toBe("node/1");
    expect(harbor.category).toBe("cafe");
    expect(harbor.address).toBe("123 Example Street, Unit B");
    expect(harbor.website).toBe("https://harborlane.example/");
    expect(harbor.email).toBe("hi@harborlane.example");
    expect(harbor.osmTags["name:es"]).toBeUndefined(); // translations dropped
    expect(harbor.osmTags["check_date"]).toBeUndefined(); // bookkeeping dropped
    const deli = places.find((p) => p.name === "Dock Street Deli")!;
    expect(deli.osmId).toBe("way/14");
    expect(deli.lat).toBeCloseTo(HQ.lat + 0.0003, 7); // way center used as position
    expect(places.find((p) => p.name === "Bad Email Books")!.email).toBeNull();
  });

  it("respects the limit", async () => {
    stubFetch(() => jsonResponse(FIXTURE));
    expect(await scoutNearby(HQ.lat, HQ.lon, 450, 2)).toHaveLength(2);
  });
});

describe("scoutNearby snapshot fallback (all Overpass mirrors down)", () => {
  it("serves the bundled OSM snapshot with the same filters", async () => {
    const { calls } = stubFetch(() => {
      throw new TypeError("network down");
    });
    const radius = 450;
    const places = await scoutNearby(HQ.lat, HQ.lon, radius, 24);

    // Every mirror was tried (twice: one retry round) before falling back.
    expect(calls.length).toBe(OVERPASS_MIRRORS.length * 2);

    expect(places.length).toBeGreaterThan(0);
    expect(places.length).toBeLessThanOrEqual(24);

    const names = places.map((p) => p.name);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length); // deduped

    // Chains in the snapshot never come back.
    for (const chain of ["Safeway", "Philz Coffee", "Blue Bottle Coffee", "Taco Bell Cantina", "The UPS Store", "Giants Dugout Store"]) {
      expect(names).not.toContain(chain);
    }
    // Brand-tagged elements are all filtered out.
    const branded = new Set(
      (SNAPSHOT as unknown as { elements: { tags?: Record<string, string> }[] }).elements
        .filter((e) => e.tags?.brand || e.tags?.["brand:wikidata"])
        .map((e) => e.tags!.name),
    );
    expect(names.filter((n) => branded.has(n))).toEqual([]);

    // Everything is inside the radius, and places with a website come first.
    for (const p of places) expect(distanceMeters(HQ.lat, HQ.lon, p.lat, p.lon)).toBeLessThanOrEqual(radius);
    const firstWithout = places.findIndex((p) => !p.website);
    if (firstWithout >= 0) expect(places.slice(firstWithout).every((p) => !p.website)).toBe(true);
  });
});

describe("findByName", () => {
  it("rejects names with fewer than two letters or digits without any request", async () => {
    const { calls } = stubFetch(() => jsonResponse([]));
    expect(await findByName("!", HQ.lat, HQ.lon)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("picks the exact-name Nominatim match within range", async () => {
    stubFetch((c) => {
      expect(c.url).toContain("nominatim.openstreetmap.org");
      return jsonResponse([
        { osm_type: "node", osm_id: 21, lat: String(HQ.lat + 0.001), lon: String(HQ.lon), category: "amenity", type: "cafe", name: "Harbor Lane Coffee Annex" },
        { osm_type: "node", osm_id: 22, lat: String(HQ.lat + 0.002), lon: String(HQ.lon), category: "amenity", type: "cafe", name: "Harbor Lane Coffee", address: { house_number: "123", road: "Example Street" } },
        { osm_type: "node", osm_id: 23, lat: String(HQ.lat), lon: String(HQ.lon), category: "highway", type: "bus_stop", name: "Harbor Lane Coffee" },
      ]);
    });
    const hit = await findByName("harbor lane coffee", HQ.lat, HQ.lon);
    expect(hit?.osmId).toBe("node/22");
    expect(hit?.address).toBe("123 Example Street");
  });
});
