import { describe, expect, it } from "vitest";
import {
  categoryLabel,
  contrast,
  decodeEntities,
  ensureContrast,
  normHex,
  parseSite,
  placeFor,
  resolveFont,
} from "../src/pipeline/brand";
import { HQ, makeBiz, makeEnv } from "./fixtures";

describe("colors", () => {
  it("normalizes hex and rgb() colors", () => {
    expect(normHex("#abc")).toBe("#AABBCC");
    expect(normHex("6b3e26")).toBe("#6B3E26");
    expect(normHex("#6B3E26FF")).toBe("#6B3E26"); // alpha dropped
    expect(normHex("rgb(255, 0, 128)")).toBe("#FF0080");
    expect(normHex("red")).toBeNull();
    expect(normHex(42)).toBeNull();
  });

  it("computes WCAG contrast ratios", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("ensureContrast darkens or lightens until the minimum is met", () => {
    const onLight = ensureContrast("#F0E0A0", "#FFFFFF", 4.5);
    expect(contrast(onLight, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    const onDark = ensureContrast("#302010", "#111111", 4.5);
    expect(contrast(onDark, "#111111")).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast("#000000", "#FFFFFF", 4.5)).toBe("#000000"); // already fine: unchanged
  });
});

describe("resolveFont", () => {
  it("keeps allowlisted Google Fonts (case-insensitive)", () => {
    expect(resolveFont("playfair display", "heading")).toBe("Playfair Display");
    expect(resolveFont('"Inter", sans-serif', "body")).toBe("Inter");
  });

  it("maps commercial fonts to a close Google Fonts family", () => {
    expect(resolveFont("Helvetica Neue", "heading")).toBe("Space Grotesk");
    expect(resolveFont("Helvetica Neue", "body")).toBe("Inter");
    expect(resolveFont("Futura PT", "heading")).toBe("Outfit");
    expect(resolveFont("Courier New", "body")).toBe("IBM Plex Mono");
  });

  it("allows fonts the business's own site already loads", () => {
    expect(resolveFont("Some Site Font", "heading", ["Some Site Font"])).toBe("Some Site Font");
  });

  it("has safe defaults", () => {
    expect(resolveFont("", "heading")).toBe("Fraunces");
    expect(resolveFont(undefined, "body")).toBe("Inter");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities and leaves unknown ones alone", () => {
    expect(decodeEntities("Caf&eacute; &amp; Bar &#8212; &#x2019;s &bogus;")).toBe("Café & Bar — ’s &bogus;");
  });
});

describe("parseSite (what the Archivist reads from a real website)", () => {
  const html = `<!doctype html><html><head>
<title>Harbor Lane Coffee &amp; Toast</title>
<meta name="description" content="Espresso and toast on Example Street.">
<meta property="og:image" content="/img/og.jpg">
<meta name="theme-color" content="#6b3e26">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&family=DM+Sans&display=swap" rel="stylesheet">
<style>body{color:#231a15;background:#faf6f0} .btn{background:#b7802f}</style>
<script>window.__STATE__ = {"secret": "should not be read", "price": "$999"}</script>
</head><body>
<h1>Harbor Lane Coffee</h1><h2>Our menu</h2>
<p>Cortado $4.50 &middot; Cinnamon toast $7 &middot; Family-owned since 2011.</p>
</body></html>`;
  const ev = parseSite(html, "https://harborlane.example", "https://www.harborlane.example/");

  it("extracts title, description, theme-color and an absolute og:image", () => {
    expect(ev.title).toBe("Harbor Lane Coffee & Toast");
    expect(ev.description).toBe("Espresso and toast on Example Street.");
    expect(ev.themeColor).toBe("#6B3E26");
    expect(ev.ogImage).toBe("https://www.harborlane.example/img/og.jpg");
  });

  it("extracts Google Fonts, headings, prices and visible text", () => {
    expect(ev.googleFonts).toEqual(expect.arrayContaining(["Fraunces", "DM Sans"]));
    expect(ev.headings).toEqual(["Harbor Lane Coffee", "Our menu"]);
    expect(ev.prices).toEqual(["$4.50", "$7"]);
    expect(ev.text).toContain("Family-owned since 2011.");
  });

  it("ignores inline scripts entirely", () => {
    expect(ev.text).not.toContain("should not be read");
    expect(ev.prices).not.toContain("$999");
  });

  it("ranks the theme-color first among brand colors", () => {
    expect(ev.colors[0].hex).toBe("#6B3E26");
    expect(ev.colors.map((c) => c.hex)).toContain("#B7802F");
  });
});

describe("placeFor and categoryLabel", () => {
  it("places a business next to HQ in SoMa, a short walk from Oracle Park", () => {
    const place = placeFor(makeBiz({ lat: HQ.lat + 0.001, lon: HQ.lon }), makeEnv());
    expect(place.neighborhood).toBe("SoMa");
    expect(place.landmark).toBe("Oracle Park");
    expect(place.phrase).toBe("SoMa, San Francisco, a short walk from Oracle Park");
    expect(place.metersFromHQ).toBe(111);
  });

  it("does not invent a neighborhood for a business with no position", () => {
    const place = placeFor(makeBiz({ lat: null, lon: null }), makeEnv());
    expect(place).toMatchObject({ neighborhood: "San Francisco", landmark: null, metersFromHQ: null, phrase: "San Francisco" });
  });

  it("labels categories in plain English, with cuisine when it helps", () => {
    expect(categoryLabel(makeBiz({ category: "cafe", osmTags: { cuisine: "coffee_shop" } }))).toBe("coffee shop");
    expect(categoryLabel(makeBiz({ category: "restaurant", osmTags: { cuisine: "argentinian" } }))).toBe("Argentinian restaurant");
    expect(categoryLabel(makeBiz({ category: "musical_instrument", osmTags: {} }))).toBe("guitar and music shop");
    expect(categoryLabel(makeBiz({ category: "", osmTags: {} }))).toBe("local business");
  });
});
