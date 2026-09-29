// Shared test fixtures. Every business here is fictional ("Harbor Lane Coffee", "Example Street"),
// so no test ever makes a claim about a real place. Coordinates sit next to Cold Open's HQ
// (101 Townsend St, San Francisco) because placeFor() and the Critic reason about distance to it.

import { vi } from "vitest";
import type { Brand, Business, Env, SiteSpec } from "../src/types";

/** HQ center used by the app (same point as the OSM snapshot center). */
export const HQ = { lat: 37.7786, lon: -122.3893 } as const;

/** An Env with no API keys: every LLM / image / Stripe call is disabled, so code under test takes
 *  its deterministic fallback path and never touches the network. */
export function makeEnv(over: Partial<Env> = {}): Env {
  return {
    PUBLIC_URL: "https://coldopen.example.test",
    PAYMENT_LINK: "",
    CLAUDE_MODEL: "",
    HQ_LAT: String(HQ.lat),
    HQ_LON: String(HQ.lon),
    ...over,
  } as unknown as Env;
}

export function makeBrand(over: Partial<Brand> = {}): Brand {
  return {
    name: "Harbor Lane Coffee",
    tagline: "Espresso and toast on Example Street",
    voice: "plain, warm, neighborly",
    vibe: "sunlit corner coffee counter",
    palette: { primary: "#6B3E26", secondary: "#EFE3D3", accent: "#B7802F", background: "#FAF6F0", text: "#231A15" },
    fonts: { heading: "Fraunces", body: "Inter" },
    keywords: ["espresso", "toast", "soma"],
    offerings: [
      { name: "Espresso drinks", description: "Short and long coffee drinks from the bar." },
      { name: "Toast", description: "Thick-cut toast with a few simple toppings." },
      { name: "Pastries", description: "A small case of morning pastries." },
    ],
    offeringsConfirmed: false,
    story: "A coffee counter on Example Street in SoMa, a short walk from Oracle Park.",
    sourceSignals: ["OSM category=cafe", "OSM address"],
    ...over,
  };
}

export function makeSpec(over: Partial<SiteSpec> = {}): SiteSpec {
  return {
    version: 1,
    theme: "warm",
    headline: "Espresso and toast on Example Street",
    subheadline: "A small coffee counter in SoMa, a short walk from Oracle Park.",
    about: "Harbor Lane Coffee pours espresso drinks and serves toast from a narrow counter on Example Street.",
    highlights: [
      { title: "Coffee first", text: "Espresso drinks pulled to order at the counter." },
      { title: "On Example Street", text: "Two blocks from the ballpark in SoMa." },
      { title: "Open hours", text: "Mon–Fri 7am–4pm, weekends from 8am." },
    ],
    offeringsTitle: "On the counter",
    offerings: [
      { name: "Espresso drinks", description: "Short and long coffee drinks from the bar." },
      { name: "Toast", description: "Thick-cut toast with a few simple toppings." },
      { name: "Pastries", description: "A small case of morning pastries." },
    ],
    ctaLabel: "Come by for coffee",
    hoursText: "Mon–Fri 7am–4pm",
    seo: { title: "Harbor Lane Coffee — café in SoMa", description: "Espresso and toast on Example Street, SoMa." },
    ...over,
  };
}

export function makeBiz(over: Partial<Business> = {}): Business {
  return {
    id: "harbor-lane-coffee",
    name: "Harbor Lane Coffee",
    category: "cafe",
    lat: 37.7781,
    lon: -122.3901,
    address: "123 Example Street",
    website: null,
    phone: "+1 415 555 0100",
    email: null,
    openingHours: "Mo-Fr 07:00-16:00",
    osmId: "node/1",
    osmTags: { amenity: "cafe" },
    status: "ready",
    brand: makeBrand(),
    site: makeSpec(),
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
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// fetch stubbing

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type Handler = (call: FetchCall) => Response | Promise<Response>;

/** Replaces global fetch with `handler` and records every call. Restored by `unstubGlobals`. */
export function stubFetch(handler: Handler): { calls: FetchCall[]; fn: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? init.body : null;
    const call: FetchCall = { url, method: (init?.method || "GET").toUpperCase(), headers, body };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
