// End-to-end run of the agent pipeline with no model keys and a stubbed website: Archivist reads the
// (fictional) site, Builder drafts, Critic scores, Closer writes the pitch, and the site renders.
// This is the path the app takes when every LLM provider is down, so it must still be honest.
import { describe, expect, it } from "vitest";
import { extractBrand, getSiteEvidence } from "../src/pipeline/brand";
import { composeSite } from "../src/pipeline/builder";
import { writePitch } from "../src/pipeline/closer";
import { critique, slopHits, unsupportedClaims } from "../src/pipeline/critic";
import { heroPrompt } from "../src/pipeline/director";
import { renderSite } from "../src/site/render";
import { htmlResponse, makeBiz, makeEnv, stubFetch } from "./fixtures";

const SITE = `<!doctype html><html><head><title>Dock Street Deli</title>
<meta name="description" content="Sandwiches and soup on Example Street since 2011.">
<meta name="theme-color" content="#2F5D50">
</head><body><h1>Dock Street Deli</h1><h2>Sandwiches</h2>
<p>Family-owned since 2011. We make turkey club, pastrami rye and tomato soup every weekday,
and we pack catering trays for offices on Example Street. Order at the counter; there is no delivery.</p>
</body></html>`;

describe("offline pipeline (no LLM keys, stubbed website)", () => {
  it("reads the site, builds, scores, pitches and renders an honest preview", async () => {
    const env = makeEnv();
    const { calls } = stubFetch((c) => {
      if (c.url.startsWith("https://dock.example")) return htmlResponse(SITE);
      throw new Error(`unexpected request to ${c.url}`);
    });
    const biz = makeBiz({
      id: "dock-street-deli",
      name: "Dock Street Deli",
      category: "deli",
      website: "https://dock.example/",
      osmTags: { shop: "deli" },
      brand: null,
      site: null,
    });

    // Archivist
    const { brand, provider: brandProvider } = await extractBrand(env, biz);
    expect(brandProvider).toBe("heuristic");
    expect(calls.map((c) => c.url)).toEqual(["https://dock.example/"]);
    expect(brand.sourceSignals).toContain('website title "Dock Street Deli"');
    expect(brand.offeringsConfirmed).toBe(false); // no model to name items, so nothing is "confirmed"
    expect(getSiteEvidence(biz.id)?.text).toContain("Family-owned since 2011");

    // The fact check now accepts what the site says, and still rejects what it doesn't.
    expect(unsupportedClaims(biz, brand, "Family-owned since 2011, with catering.")).toEqual([]);
    expect(unsupportedClaims(biz, brand, "Award-winning sandwiches with a patio.")).toEqual(["Award-winning", "patio"]);

    // Builder
    const { spec } = await composeSite(env, biz, brand, null);
    expect(spec.highlights).toHaveLength(3);
    expect(spec.offerings.every((o) => !o.price)).toBe(true);
    expect(slopHits(JSON.stringify(spec))).toEqual([]);

    // Critic (heuristic path): a score in range, labeled as heuristic.
    const { version } = await critique(env, biz, brand, spec);
    expect(version.provider).toBe("heuristic");
    expect(version.score).toBeGreaterThanOrEqual(0);
    expect(version.score).toBeLessThanOrEqual(100);

    // Closer: fixed honest template, $49 offer, opt-out, no hype.
    const { pitch, provider: pitchProvider } = await writePitch(env, biz, brand, spec);
    expect(pitchProvider).toBe("template");
    expect(pitch.subject).toBe("We built Dock Street Deli a website (before asking)");
    expect(pitch.body).toContain("https://coldopen.example.test/s/dock-street-deli");
    expect(pitch.body).toContain("$49");
    expect(pitch.body).toContain('Reply "remove"');
    expect(pitch.body).not.toContain("!");
    expect(pitch.body.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(140);

    // Director prompt: no text/logos in generated imagery.
    const prompt = heroPrompt(biz, brand, spec);
    expect(prompt).toContain("No text, no letters, no words, no logos");
    expect(prompt.length).toBeLessThanOrEqual(1500);

    // Render
    const html = renderSite({ ...biz, brand, site: spec, scores: [version], status: "ready" }, { publicUrl: env.PUBLIC_URL });
    expect(html).toContain("Unofficial concept preview made for <b>Dock Street Deli</b>");
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain('href="/s/dock-street-deli/remove"');
  });

  it("treats an unreachable website as 'could not be read' instead of guessing", async () => {
    stubFetch(() => {
      throw new TypeError("network down");
    });
    const biz = makeBiz({ id: "unreachable", website: "https://down.example/", brand: null, site: null });
    const { brand } = await extractBrand(makeEnv(), biz);
    expect(brand.sourceSignals).toContain("website https://down.example/ could not be read");
    expect(getSiteEvidence(biz.id)).toBeNull();
    expect(brand.offeringsConfirmed).toBe(false);
  });
});
