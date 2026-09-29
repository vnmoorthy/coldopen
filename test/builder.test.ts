import { describe, expect, it } from "vitest";
import { composeSite, humanizeHours, pickTheme } from "../src/pipeline/builder";
import { slopHits } from "../src/pipeline/critic";
import { makeBiz, makeBrand, makeEnv, makeSpec } from "./fixtures";

describe("humanizeHours (OSM opening_hours -> readable text)", () => {
  it.each([
    ["Mo-Fr 07:00-16:00; Sa 08:00-13:00", "Mon–Fri 7am–4pm · Sat 8am–1pm"],
    ["Mo-Su 11:00-22:00", "Daily 11am–10pm"],
    ["Mo-Fr 12:00-00:00", "Mon–Fri noon–midnight"],
    ["Fr-Sa 18:00-02:00", "Fri–Sat 6pm–2am"],
    ["Mo-Fr 11:30-14:30,17:00-21:30", "Mon–Fri 11:30am–2:30pm, 5pm–9:30pm"],
    ["Mo,We,Fr 09:00-17:00", "Mon, Wed, Fri 9am–5pm"],
    ["Mo-Su 10:00-20:00; PH off", "Daily 10am–8pm"],
    ["24/7", "Open 24 hours, every day"],
  ])("%s -> %s", (raw, expected) => {
    expect(humanizeHours(raw)).toBe(expected);
  });

  it("lists closed days after open days", () => {
    expect(humanizeHours("Mo off; Tu-Su 08:00-15:00")).toBe("Tue–Sun 8am–3pm · Mon closed");
  });

  it("asks the owner to confirm when hours are unknown or never open", () => {
    expect(humanizeHours(null)).toBe("Hours — owner to confirm");
    expect(humanizeHours("   ")).toBe("Hours — owner to confirm");
    expect(humanizeHours("Mo-Su off")).toBe("Hours — owner to confirm");
  });

  it("returns syntax it cannot parse verbatim rather than guessing", () => {
    expect(humanizeHours("sunrise-sunset")).toBe("sunrise-sunset");
    expect(humanizeHours("Mo-Fr 9am-5pm")).toBe("Mo-Fr 9am-5pm");
  });
});

describe("pickTheme", () => {
  it("reads the theme from brand vibe words", () => {
    const biz = makeBiz({ category: "restaurant" });
    expect(pickTheme(makeBrand({ vibe: "neon arcade, loud and late-night", voice: "brash", keywords: [] }), biz)).toBe("bold");
    expect(pickTheme(makeBrand({ vibe: "rustic, sunlit and cozy", voice: "gentle", keywords: [] }), biz)).toBe("warm");
    expect(pickTheme(makeBrand({ vibe: "minimal, modern, refined", voice: "calm", keywords: [] }), biz)).toBe("editorial");
  });

  it("falls back to the category when the brand says nothing", () => {
    const quiet = makeBrand({ vibe: "", voice: "", keywords: [] });
    expect(pickTheme(quiet, makeBiz({ category: "pub" }))).toBe("bold");
    expect(pickTheme(quiet, makeBiz({ category: "bakery" }))).toBe("warm");
    expect(pickTheme(quiet, makeBiz({ category: "books" }))).toBe("editorial");
  });

  it("breaks ties in favor of the category default", () => {
    const tied = makeBrand({ vibe: "bold and warm", voice: "", keywords: [] });
    expect(pickTheme(tied, makeBiz({ category: "cafe" }))).toBe("warm");
    expect(pickTheme(tied, makeBiz({ category: "bar" }))).toBe("bold");
  });
});

describe("composeSite (deterministic draft, no model configured)", () => {
  const env = makeEnv();

  it("builds a complete v1 spec from facts only", async () => {
    const biz = makeBiz({ id: "build-1" });
    const { spec, provider, costCents } = await composeSite(env, biz, makeBrand(), null);
    expect(provider).toBe("heuristic");
    expect(costCents).toBe(0);
    expect(spec.version).toBe(1);
    expect(spec.highlights).toHaveLength(3);
    expect(spec.offerings.length).toBeGreaterThanOrEqual(3);
    expect(spec.hoursText).toBe("Mon–Fri 7am–4pm");
    expect(spec.headline).toContain("Example Street");
    expect(spec.ctaLabel).toBe("Come by for coffee");
    expect(spec.seo.title.length).toBeLessThanOrEqual(60);
    expect(spec.seo.description.length).toBeLessThanOrEqual(156);
    expect(slopHits(JSON.stringify(spec))).toEqual([]);
  });

  it("never shows prices when the menu was not confirmed from the business's own site", async () => {
    const brand = makeBrand({
      offeringsConfirmed: false,
      offerings: [
        { name: "Latte", description: "Milk and espresso.", price: "$6" },
        { name: "Toast", description: "Thick-cut toast.", price: "$9" },
        { name: "Cookie", description: "One cookie.", price: "$3" },
      ],
    });
    const { spec } = await composeSite(env, makeBiz({ id: "build-2" }), brand, null);
    expect(spec.offerings.every((o) => o.price === undefined)).toBe(true);
  });

  it("keeps confirmed prices exactly as read", async () => {
    const brand = makeBrand({
      offeringsConfirmed: true,
      offerings: [
        { name: "Latte", description: "Milk and espresso.", price: "$6" },
        { name: "Toast", description: "Thick-cut toast.", price: "$9" },
        { name: "Cookie", description: "One cookie." },
      ],
    });
    const { spec } = await composeSite(env, makeBiz({ id: "build-3" }), brand, null);
    expect(spec.offerings.map((o) => [o.name, o.price])).toEqual([
      ["Latte", "$6"],
      ["Toast", "$9"],
      ["Cookie", undefined],
    ]);
  });

  it("uses an honest placeholder when hours are unknown", async () => {
    const { spec } = await composeSite(env, makeBiz({ id: "build-4", openingHours: null }), makeBrand(), null);
    expect(spec.hoursText).toBe("Hours — owner to confirm");
    expect(spec.highlights).toHaveLength(3);
  });

  it("on a revision, removes a claim the Critic flagged and bumps the version", async () => {
    const brand = makeBrand({ story: "Family-owned since 1998. A coffee counter on Example Street in SoMa." });
    const biz = makeBiz({ id: "build-5" });
    const prev = makeSpec({ version: 1, theme: "editorial" });
    const feedback = ['Unsupported claim "Family-owned" in "Family-owned since 1998." — nothing we read says this. Cut it or replace it with a fact.'];
    const { spec } = await composeSite(env, biz, brand, prev, feedback);
    expect(spec.version).toBe(2);
    expect(spec.theme).toBe("editorial"); // theme carries over unless a note asks for a new one
    expect(spec.about).not.toMatch(/family-owned/i);
    expect(spec.about).toContain("Example Street");
  });
});
