import { describe, expect, it } from "vitest";
import { esc, renderClaimed, renderNotFound, renderRemoveConfirm, renderRemoved, renderSite } from "../src/site/render";
import type { SiteTheme } from "../src/types";
import { makeBiz, makeBrand, makeSpec } from "./fixtures";

const PUBLIC_URL = "https://coldopen.example.test";
const NOINDEX = '<meta name="robots" content="noindex,nofollow">';
const THEMES: SiteTheme[] = ["editorial", "bold", "warm"];

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("esc", () => {
  it("escapes every HTML-significant character", () => {
    expect(esc(`<a href="x" onclick='y'>&\`</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;");
  });

  it("stringifies null, undefined and numbers safely", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(49)).toBe("49");
  });
});

describe("renderSite: honesty labels", () => {
  it.each(THEMES)("%s theme carries the unofficial banner, noindex and claim/remove links", (theme) => {
    const biz = makeBiz({ id: "harbor-lane-coffee", site: makeSpec({ theme }) });
    const html = renderSite(biz, { publicUrl: PUBLIC_URL });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Unofficial concept preview made for <b>Harbor Lane Coffee</b> by Cold Open — not the official site.");
    expect(html).toContain(NOINDEX);
    expect(html).toContain('href="/s/harbor-lane-coffee/claim"');
    expect(html).toContain('href="/s/harbor-lane-coffee/remove"');
    expect(html).toContain("Not affiliated with or endorsed by Harbor Lane Coffee.");
    expect(html).toContain(`class="t-${theme}"`);
  });

  it("hides the claim button once paid but always keeps the remove link", () => {
    const html = renderSite(makeBiz({ status: "paid" }), { publicUrl: PUBLIC_URL });
    expect(html).not.toContain("/claim");
    expect(html).toContain("Claimed — handoff in progress");
    expect(html).toContain('href="/s/harbor-lane-coffee/remove"');
  });

  it("never shows prices unless the menu was confirmed from the business's own site", () => {
    const offerings = [
      { name: "Latte", description: "Milk and espresso.", price: "$6.75" },
      { name: "Toast", description: "Thick-cut toast.", price: "$9.25" },
      { name: "Cookie", description: "One cookie.", price: "$3.50" },
    ];
    const unconfirmed = renderSite(
      makeBiz({ brand: makeBrand({ offeringsConfirmed: false }), site: makeSpec({ offerings }) }),
      { publicUrl: PUBLIC_URL },
    );
    expect(unconfirmed).toContain("Latte");
    expect(unconfirmed).not.toContain("$6.75");
    const confirmed = renderSite(
      makeBiz({ brand: makeBrand({ offeringsConfirmed: true }), site: makeSpec({ offerings }) }),
      { publicUrl: PUBLIC_URL },
    );
    expect(confirmed).toContain("$6.75");
  });

  it("URL-encodes odd business ids in links", () => {
    const html = renderSite(makeBiz({ id: "a b/c" }), { publicUrl: PUBLIC_URL });
    expect(html).toContain('href="/s/a%20b%2Fc/claim"');
    expect(html).toContain('href="/s/a%20b%2Fc/remove"');
  });

  it("shows the taste-gate score in the 'how this was made' notes", () => {
    const scores = [
      { version: 1, score: 58, notes: [], slopHits: [], provider: "test", at: 0 },
      { version: 2, score: 96, notes: [], slopHits: [], provider: "test", at: 0 },
    ];
    const html = renderSite(makeBiz({ scores }), { publicUrl: PUBLIC_URL });
    expect(html).toContain("<b>96/100</b> after 2 drafts");
  });
});

describe("renderSite: XSS safety", () => {
  const PAYLOAD = "<script>alert(1)</script>";
  const ATTR_BREAKOUT = '"><img src=x onerror=alert(2)>';

  function hostileBiz(theme: SiteTheme) {
    return makeBiz({
      id: "hostile",
      name: PAYLOAD,
      address: `${ATTR_BREAKOUT} Example Street`,
      website: "javascript:alert(3)",
      heroImage: "javascript:alert(4)",
      phone: "<svg onload=alert(5)>",
      osmTags: { amenity: "cafe", cuisine: PAYLOAD },
      brand: makeBrand({
        name: PAYLOAD,
        tagline: PAYLOAD,
        story: `Story ${PAYLOAD}`,
        keywords: [PAYLOAD],
        sourceSignals: [PAYLOAD],
        palette: { primary: "red;}</style><script>alert(6)</script>", secondary: "#fff", accent: "#000", background: "#fff", text: "#000" },
        fonts: { heading: "</style><script>alert(7)</script>", body: "Inter" },
      }),
      site: makeSpec({
        theme,
        headline: PAYLOAD,
        subheadline: ATTR_BREAKOUT,
        about: PAYLOAD,
        highlights: [
          { title: PAYLOAD, text: ATTR_BREAKOUT },
          { title: "B", text: PAYLOAD },
          { title: "C", text: "ok" },
        ],
        offeringsTitle: PAYLOAD,
        offerings: [{ name: PAYLOAD, description: ATTR_BREAKOUT }],
        ctaLabel: PAYLOAD,
        hoursText: PAYLOAD,
        seo: { title: PAYLOAD, description: ATTR_BREAKOUT },
      }),
    });
  }

  it.each(THEMES)("%s theme escapes every user-controlled field", (theme) => {
    const html = renderSite(hostileBiz(theme), { publicUrl: PUBLIC_URL });
    const benign = renderSite(makeBiz({ site: makeSpec({ theme }) }), { publicUrl: PUBLIC_URL });

    expect(html).not.toContain(PAYLOAD);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toMatch(/alert\([1-7]\)<\/script>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // No extra script tags were injected: the page has exactly the renderer's own scripts.
    expect(count(html, "<script")).toBe(count(benign, "<script"));
    // javascript: URLs are dropped, not linked.
    expect(html).not.toMatch(/(href|src)="javascript:/i);
    // The full themed page rendered (not the renderer's error fallback), banner included.
    expect(html).toContain(`class="t-${theme}"`);
    expect(console.error).not.toHaveBeenCalled();
    expect(html).toContain("Unofficial concept preview made for");
    expect(html).toContain(NOINDEX);
  });
});

describe("renderSite: non-ready states", () => {
  it("renders the removed page for a removed business", () => {
    const html = renderSite(makeBiz({ status: "removed" }), { publicUrl: PUBLIC_URL });
    expect(html).toContain("Removed.");
    expect(html).toContain("Sorry for the intrusion.");
    expect(html).not.toContain("/claim");
  });

  it("renders a self-refreshing pending page while the site is being built", () => {
    const html = renderSite(makeBiz({ status: "building", site: null }), { publicUrl: PUBLIC_URL });
    expect(html).toContain("Being built right now.");
    expect(html).toContain("Builder is composing the site");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain(NOINDEX);
  });
});

describe("utility pages", () => {
  it("renderRemoved names the business, escaped", () => {
    const html = renderRemoved("<b>Harbor</b>");
    expect(html).toContain("Preview for &lt;b&gt;Harbor&lt;/b&gt;");
    expect(html).not.toContain("<b>Harbor</b>");
    expect(html).toContain(NOINDEX);
  });

  it("renderRemoved works without a name", () => {
    const html = renderRemoved();
    expect(html).toContain("Preview removed");
    expect(html).toContain("This concept preview is offline");
  });

  it("renderNotFound is a styled, noindexed 404", () => {
    const html = renderNotFound();
    expect(html).toContain("404");
    expect(html).toContain("No preview here.");
    expect(html).toContain(NOINDEX);
  });

  it("renderRemoveConfirm posts to the remove endpoint", () => {
    const html = renderRemoveConfirm(makeBiz());
    expect(html).toContain('<form method="post" action="/s/harbor-lane-coffee/remove"');
    expect(html).toContain("Take this preview down?");
  });

  it("renderClaimed(verified: true) says Stripe verified the payment", () => {
    const biz = makeBiz({ status: "paid", amountCents: 4900, paidAt: Date.UTC(2026, 8, 28, 22) });
    const html = renderClaimed(biz, { verified: true, publicUrl: PUBLIC_URL });
    expect(html).toContain("Payment verified by Stripe");
    expect(html).not.toContain("test mode");
    expect(html).toContain("$49.00 paid");
    expect(html).toContain("Ref harbor-lane-coffee");
    expect(html).toContain('href="/s/harbor-lane-coffee"');
  });

  it("renderClaimed(verified: false) is labeled as test mode", () => {
    const html = renderClaimed(makeBiz(), { verified: false, publicUrl: PUBLIC_URL });
    expect(html).toContain("Payment received (test mode)");
    expect(html).not.toContain("Payment verified by Stripe");
  });

  it("renderClaimed without a matched business still thanks the buyer honestly", () => {
    const html = renderClaimed(null, { verified: false, publicUrl: PUBLIC_URL });
    expect(html).toContain("couldn't match it to a specific preview");
    expect(html).toContain("It’s yours — Cold Open");
  });

  it("renderClaimed escapes the business name", () => {
    const html = renderClaimed(makeBiz({ name: "<script>alert(1)</script>" }), { verified: true, publicUrl: PUBLIC_URL });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
