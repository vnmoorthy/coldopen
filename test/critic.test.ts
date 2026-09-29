import { describe, expect, it } from "vitest";
import { critique, scrubSlop, slopHits, specText, unsupportedClaims } from "../src/pipeline/critic";
import { makeBiz, makeBrand, makeEnv, makeSpec } from "./fixtures";

describe("slopHits (banned phrases)", () => {
  it("finds each distinct banned phrase once, in list order", () => {
    const text = "Nestled in the heart of SoMa, our culinary journey will elevate your taste buds. Elevate!";
    expect(slopHits(text)).toEqual(["elevate", "nestled", "culinary journey", "in the heart of", "tastebuds"]);
  });

  it("lets 'culinary journey' absorb the bare 'culinary' hit", () => {
    expect(slopHits("A culinary journey.")).toEqual(["culinary journey"]);
    expect(slopHits("Culinary staff.")).toEqual(["culinary"]);
  });

  it("is case-insensitive and handles curly apostrophes", () => {
    expect(slopHits("WHETHER YOU’RE NEW OR NOT")).toEqual(["whether you're"]);
    expect(slopHits("You won’t be disappointed")).toEqual(["you won't be disappointed"]);
  });

  it("matches word forms and hyphen variants", () => {
    expect(slopHits("It boasts a world class, state of the art, game-changing menu")).toEqual([
      "world-class",
      "game-changer",
      "boasts",
      "state-of-the-art",
    ]);
  });

  it("does not flag plain, specific copy", () => {
    expect(slopHits("Espresso drinks and toast on Example Street, open 7am to 4pm.")).toEqual([]);
    expect(slopHits("")).toEqual([]);
  });

  it("does not match banned words inside longer words", () => {
    expect(slopHits("An elevator to the second floor.")).toEqual([]);
  });

  it("is stable across repeated calls (global regex lastIndex is reset)", () => {
    const text = "A hidden gem with vibrant decor.";
    const first = slopHits(text);
    expect(first).toEqual(["hidden gem", "vibrant"]);
    for (let i = 0; i < 5; i++) expect(slopHits(text)).toEqual(first);
  });
});

describe("scrubSlop", () => {
  it("returns clean text unchanged", () => {
    const t = "Espresso on Example Street.";
    expect(scrubSlop(t)).toBe(t);
  });

  it("patches phrases that have a safe replacement", () => {
    expect(scrubSlop("Our bespoke blends are poured daily.")).toBe("Our custom blends are poured daily.");
  });

  it("drops a sentence whose slop cannot be patched when other sentences remain", () => {
    const out = scrubSlop("Espresso on Example Street. Look no further for coffee. Toast all day.");
    expect(out).toBe("Espresso on Example Street. Toast all day.");
  });

  it("cuts the phrase instead of dropping when allowDrop is false", () => {
    const out = scrubSlop("Espresso and toast, a hidden gem", false);
    expect(slopHits(out)).toEqual([]);
    expect(out).toContain("Espresso and toast");
  });

  it("leaves no banned phrase behind in realistic copy", () => {
    const samples = [
      "Nestled on Example Street, we serve espresso. Our vibrant counter is warm and welcoming.",
      "A curated list of teas. Indulge in toast with jam. Open every morning.",
      "We boast the best toast. It is a testament to bread. Come by.",
    ];
    for (const s of samples) expect(slopHits(scrubSlop(s))).toEqual([]);
  });
});

describe("specText", () => {
  it("collects every visible copy field of a site spec", () => {
    const text = specText(makeSpec());
    for (const needle of ["Espresso and toast on Example Street", "Coffee first", "Pastries", "Come by for coffee", "café in SoMa"]) {
      expect(text).toContain(needle);
    }
  });
});

describe("unsupportedClaims (fact check vs evidence)", () => {
  it("flags claims nothing we read supports", () => {
    const biz = makeBiz({ id: "claims-1", osmTags: { amenity: "cafe" } });
    const brand = makeBrand({ story: "A coffee counter on Example Street." });
    const claims = unsupportedClaims(biz, brand, "Family-owned since 1998, with award-winning pastries and free delivery.");
    expect(claims).toEqual(["Family-owned", "since 1998", "award-winning", "free delivery"]);
  });

  it("accepts claims backed by OpenStreetMap tags, including synonyms", () => {
    const biz = makeBiz({ id: "claims-2", osmTags: { amenity: "cafe", outdoor_seating: "yes", takeaway: "yes", internet_access: "wlan" } });
    const claims = unsupportedClaims(biz, makeBrand(), "Grab a seat on the patio, use the wifi, or get it to go as takeout.");
    expect(claims).toEqual([]);
  });

  it("accepts claims backed by the brand story", () => {
    const biz = makeBiz({ id: "claims-3" });
    const brand = makeBrand({ story: "A family-owned bakery, established in 2004, baking bread since 2004." });
    expect(unsupportedClaims(biz, brand, "Family-owned and baking since 2004.")).toEqual([]);
  });

  it("reports each claim once even if repeated", () => {
    const biz = makeBiz({ id: "claims-4" });
    expect(unsupportedClaims(biz, makeBrand(), "Famous toast. Truly famous. FAMOUS.")).toEqual(["Famous"]);
  });

  it("ignores ordinary copy", () => {
    expect(unsupportedClaims(makeBiz({ id: "claims-5" }), makeBrand(), "Espresso and toast on Example Street.")).toEqual([]);
  });
});

describe("critique scoring (heuristic path, no model configured)", () => {
  const env = makeEnv();

  it("scores a clean, specific draft at the heuristic baseline with no deductions", async () => {
    const { version, costCents } = await critique(env, makeBiz({ id: "crit-clean" }), makeBrand(), makeSpec());
    expect(version.provider).toBe("heuristic");
    expect(version.score).toBe(86);
    expect(version.slopHits).toEqual([]);
    expect(version.notes).toEqual(["Rubric model unavailable — this score only reflects structure, fact checks and banned phrases."]);
    expect(costCents).toBe(0);
  });

  it("deducts 6 points per banned phrase", async () => {
    const spec = makeSpec({ about: "Nestled on Example Street, a hidden gem for espresso drinks and toast." });
    const { version } = await critique(env, makeBiz({ id: "crit-slop" }), makeBrand(), spec);
    expect(version.slopHits).toEqual(["nestled", "hidden gem"]);
    expect(version.score).toBe(86 - 12);
  });

  it("applies structural deductions and explains each one", async () => {
    const spec = makeSpec({
      headline: "Harbor Lane Coffee", // only repeats the name (-2)
      highlights: makeSpec().highlights.slice(0, 2), // needs exactly 3 (-4)
      offerings: [{ name: "Toast", description: "Bread.", price: "$99" }], // < 3 offerings (-3), unconfirmed price (-10)
      ctaLabel: "Learn more", // generic CTA (-3)
    });
    const { version } = await critique(env, makeBiz({ id: "crit-struct" }), makeBrand(), spec);
    expect(version.score).toBe(86 - 2 - 4 - 3 - 10 - 3);
    const notes = version.notes.join("\n");
    expect(notes).toMatch(/only repeats the name/);
    expect(notes).toMatch(/exactly 3 highlights/);
    expect(notes).toMatch(/remove every price/);
    expect(notes).toMatch(/CTA "Learn more" is generic/);
  });

  it("deducts for unsupported claims found in the draft", async () => {
    const spec = makeSpec({ about: "Harbor Lane Coffee is award-winning and family-owned, on Example Street." });
    const { version } = await critique(env, makeBiz({ id: "crit-claims" }), makeBrand(), spec);
    expect(version.score).toBe(86 - 6 - 6);
    expect(version.notes.some((n) => n.includes('Unsupported claim "award-winning"'))).toBe(true);
  });

  it("clamps the score to 0 instead of going negative", async () => {
    const slop =
      "Nestled in the heart of SoMa, a hidden gem and best-kept secret. Elevate and unleash a culinary journey. " +
      "Mouthwatering, delectable, exquisite, world-class, unparalleled, seamless and vibrant. Indulge.";
    const { version } = await critique(env, makeBiz({ id: "crit-clamp" }), makeBrand(), makeSpec({ about: slop }));
    expect(version.slopHits.length).toBeGreaterThanOrEqual(15);
    expect(version.score).toBe(0);
  });

  it("never returns more than 8 notes and keeps the draft version number", async () => {
    const spec = makeSpec({
      version: 3,
      headline: "A very long headline that clearly runs far past nine words in total",
      subheadline: Array(30).fill("word").join(" "),
      highlights: [],
      offerings: [],
      ctaLabel: "Click here",
      about: "Award-winning, famous, legendary, voted best in town, with free delivery!!!",
    });
    const { version } = await critique(env, makeBiz({ id: "crit-many" }), makeBrand(), spec);
    expect(version.version).toBe(3);
    expect(version.notes.length).toBeLessThanOrEqual(8);
    expect(version.score).toBeGreaterThanOrEqual(0);
    expect(version.score).toBeLessThanOrEqual(100);
  });
});
