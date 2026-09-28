// Director: art-directs a hero frame for the site and stores it in KV.
// Chain: Workers AI FLUX.1 schnell -> FLUX.2 klein -> OpenAI gpt-image-1 -> dall-e-3 -> the business's
// own og:image (re-hosted) -> throw (the site then ships its typographic hero).

import type { Brand, Business, Env, SiteSpec } from "../types";
import { cuisineList, getSiteEvidence } from "./brand";
import { aiRun, workersAiStatus } from "../llm";
import { openaiKey } from "../integrations/openai";

const FLUX_SCHNELL = "@cf/black-forest-labs/flux-1-schnell";
const FLUX_KLEIN = "@cf/black-forest-labs/flux-2-klein-4b";
const IMAGE_TIMEOUT_MS = 50_000;

// Rough Workers AI list prices, in cents per image at our settings (estimates for the CFO).
const COST_SCHNELL_CENTS = 0.07; // 1024x1024 tiles + 6 steps
const COST_KLEIN_CENTS = 0.2;
const COST_GPT_IMAGE_CENTS = 2; // gpt-image-1, 1536x1024, quality "low" (~$0.02)
const COST_DALLE3_CENTS = 8; // dall-e-3, 1792x1024, standard
const OPENAI_IMAGE_TIMEOUT_MS = 60_000;
const DALLE_TIMEOUT_MS = 40_000;
const MAX_IMAGE_BYTES = 8_000_000;

// ---------------------------------------------------------------------------------------------
// Prompt

const CUISINE_SCENES: [RegExp, string][] = [
  [/argentin/, "golden baked empanadas and a cortado on a small marble café table"],
  [/mexican|taco/, "street tacos with lime wedges, cilantro and salsa roja on a hand-painted ceramic plate"],
  [/indian|nepal|himalaya|tibet/, "copper bowls of curry, torn naan and basmati rice on a dark wood table, gentle steam"],
  [/peruvian/, "ceviche in a stone bowl with red onion and corn, a frothy pisco sour beside it"],
  [/japanese|sushi|ramen/, "a tidy Japanese café set: rice bowl, miso soup and green tea on a pale wood counter"],
  [/chinese|dim sum|dumpling/, "bamboo steamers of dumplings on a lacquered table, soft steam"],
  [/thai|vietnam|pho/, "a steaming bowl of noodle soup with fresh herbs and lime on a wooden table"],
  [/korean/, "a spread of Korean banchan in small bowls around a sizzling stone pot"],
  [/italian|pizza/, "a blistered wood-fired pizza on a floured steel counter, basil leaves"],
  [/mediterranean|greek|lebanese|middle eastern|falafel/, "a spread of hummus, falafel, charred pita and herbs on a stone table"],
  [/bagel/, "fresh bagels with cream cheese and everything seasoning on butcher paper"],
  [/bubble tea/, "bubble tea cups with tapioca pearls lined up on a bright counter"],
  [/ice cream|dessert|donut|cake/, "scoops of ice cream in waffle cones held against a pastel storefront"],
  [/burger/, "a stacked smash burger with melted cheese on waxed paper, fries on the side"],
  [/sandwich|deli/, "a thick deli sandwich cut in half on butcher paper, pickles on the side"],
  [/poke|seafood|fish/, "a bright poke bowl with cubed fish, avocado and sesame"],
  [/bar & grill|american/, "a burger, fries and a cold draft beer on a wooden bar top"],
  [/breakfast|brunch/, "eggs, toast and coffee on a sunny café table by a window"],
  [/vegan|vegetarian|salad/, "a colorful grain bowl with roasted vegetables and herbs on a linen napkin"],
];

const CATEGORY_SCENES: [RegExp, string][] = [
  [/^(cafe|coffee)$/, "a ceramic cup of espresso with latte art on a worn wooden counter, pastries softly out of focus"],
  [/^(bar|pub|biergarten|nightclub)$/, "cocktails on a dark bar top with warm backlit bottles glowing behind, bokeh"],
  [/^(bakery|pastry)$/, "croissants and crusty loaves cooling on a wire rack, a dusting of flour"],
  [/^ice_cream$/, "scoops of ice cream in waffle cones held against a pastel storefront"],
  [/^(restaurant|fast_food|food_court)$/, "a beautifully plated dish on a table by a big window"],
  [/^(bicycle|bicycle_rental)$/, "a steel road bike leaning against a brick wall in a workshop, tools on a pegboard"],
  [/^books$/, "stacked books and a brass reading lamp in a quiet independent bookshop"],
  [/^games$/, "board game pieces, dice and trading cards on a wooden table under warm lamp light"],
  [/^musical_instrument$/, "acoustic and electric guitars hanging on a shop wall, warm light on the wood grain"],
  [/^(massage|beauty|cosmetics|hairdresser|barber)$/, "folded white towels, smooth stones and a eucalyptus sprig in a calm treatment room"],
  [/^(dry_cleaning|laundry)$/, "crisp pressed shirts on wooden hangers in soft window light"],
  [/^(wine|alcohol)$/, "wine bottles on wooden shelves and a poured glass of red catching the light"],
  [/^(gift|art|craft|interior_decoration|furniture)$/, "handmade objects arranged on a sunlit shelf in a small independent shop"],
  [/^(clothes|shoes|bag|jewelry)$/, "a neat rail of garments and a few accessories in a bright boutique"],
  [/^florist$/, "buckets of fresh-cut flowers on a sidewalk in morning light"],
  [/^(fitness_centre|yoga|sports)$/, "a calm, sunlit studio with mats and plants"],
  [/^(tattoo)$/, "a tattoo artist's tidy workstation with ink caps and sketches, moody light"],
];

const HUES: [number, string][] = [
  [15, "red"], [40, "burnt orange"], [55, "amber"], [70, "golden yellow"], [95, "olive"], [150, "green"],
  [185, "teal"], [215, "blue"], [250, "indigo"], [285, "violet"], [330, "magenta"], [360, "red"],
];

function colorWord(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
  if (s < 0.12) return l > 0.85 ? "warm white" : l < 0.2 ? "charcoal" : "stone grey";
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  if (h >= 15 && h < 45 && l < 0.4) return l < 0.25 ? "deep brown" : "terracotta";
  if (l > 0.82) return "soft cream";
  const name = HUES.find(([limit]) => h < limit)?.[1] || "red";
  const shade = l < 0.3 ? "deep " : l > 0.65 ? "pale " : "";
  return shade + name;
}

export function heroPrompt(biz: Business, brand: Brand, spec?: SiteSpec | null): string {
  const cuisine = cuisineList(biz).join(" ").toLowerCase();
  const cat = (biz.category || "").toLowerCase();
  let scene = CUISINE_SCENES.find(([re]) => re.test(cuisine))?.[1];
  if (/^(bar|pub)$/.test(cat) && /sport/i.test(`${biz.name} ${brand.vibe}`)) scene = "cold draft beers on a wooden bar with blurred screens glowing in the background";
  if (!scene) scene = CATEGORY_SCENES.find(([re]) => re.test(cat))?.[1];
  if (!scene) {
    const first = brand.offerings[0]?.name;
    scene = first ? `${first.toLowerCase()} displayed inside a small independent shop` : "the inside of a small independent shop with warm light and well-kept shelves";
  }
  const colors = Array.from(
    new Set([brand.palette.primary, brand.palette.accent, brand.palette.secondary].map(colorWord).filter((c): c is string => !!c)),
  ).slice(0, 3);
  const theme = spec?.theme || "editorial";
  const mood =
    theme === "bold"
      ? "high contrast, punchy color, dramatic side light"
      : theme === "warm"
        ? "soft golden morning light, gentle shadows, inviting"
        : "clean natural daylight, calm and considered composition, generous negative space";
  const vibe = (brand.vibe || "").replace(/["\n]/g, " ").slice(0, 90);
  return [
    `Cinematic editorial photograph: ${scene}.`,
    vibe ? `Mood: ${vibe}.` : "",
    `${mood}.`,
    colors.length ? `Color palette of ${colors.join(", ")}.` : "",
    "Shot on 35mm, shallow depth of field, natural film grain, wide 16:9 composition with room for a headline on one side.",
    "No text, no letters, no words, no logos, no signage, no watermarks, no people's faces close-up.",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1500);
}

// ---------------------------------------------------------------------------------------------
// Image bytes

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function toBytes(out: unknown): Promise<Uint8Array | null> {
  if (!out) return null;
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (typeof ReadableStream !== "undefined" && out instanceof ReadableStream) return streamToBytes(out as ReadableStream<Uint8Array>);
  if (out instanceof Response) return new Uint8Array(await out.arrayBuffer());
  if (typeof out === "string") return out.length > 100 ? b64ToBytes(out) : null;
  if (typeof out === "object") {
    const o = out as Record<string, unknown>;
    for (const k of ["image", "images", "data", "result", "output"]) {
      const v = o[k];
      if (Array.isArray(v) && v.length) return toBytes(v[0]);
      if (v) return toBytes(v);
    }
  }
  return null;
}

function sniffType(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

async function run(env: Env, model: string, input: unknown): Promise<unknown> {
  return aiRun(env, model, input, IMAGE_TIMEOUT_MS);
}

async function viaSchnell(env: Env, prompt: string): Promise<Uint8Array> {
  const out = await run(env, FLUX_SCHNELL, { prompt, steps: 6 });
  const bytes = await toBytes(out);
  if (!bytes || !sniffType(bytes)) throw new Error("flux-1-schnell returned no image");
  return bytes;
}

async function viaKlein(env: Env, prompt: string): Promise<Uint8Array> {
  // FLUX.2 models take multipart form input on Workers AI.
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1280");
  form.append("height", "720");
  const packed = new Response(form);
  let out: unknown;
  try {
    out = await run(env, FLUX_KLEIN, { multipart: { body: packed.body, contentType: packed.headers.get("content-type") || "multipart/form-data" } });
  } catch (e) {
    if (!workersAiStatus().ok) throw e;
    // Some deployments accept a plain JSON prompt instead.
    out = await run(env, FLUX_KLEIN, { prompt, width: 1280, height: 720 }).catch(() => {
      throw e;
    });
  }
  const bytes = await toBytes(out);
  if (!bytes || !sniffType(bytes)) throw new Error("flux-2-klein-4b returned no image");
  return bytes;
}

// ---- OpenAI images ---------------------------------------------------------------------------

async function openaiImage(key: string, body: Record<string, unknown>, timeoutMs: number): Promise<Uint8Array> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message?.slice(0, 200) || msg;
    } catch {
      /* keep raw */
    }
    const err = new Error(`${body.model} ${res.status}: ${msg}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const json = JSON.parse(text) as { data?: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (item?.b64_json) return b64ToBytes(item.b64_json);
  if (item?.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(15_000) });
    if (img.ok) return new Uint8Array(await img.arrayBuffer());
  }
  throw new Error(`${body.model} returned no image`);
}

async function viaGptImage(key: string, prompt: string): Promise<Uint8Array> {
  const base = { model: "gpt-image-1", prompt, size: "1536x1024", quality: "low", n: 1 };
  let bytes: Uint8Array;
  try {
    // JPEG keeps the KV object small (PNG at 1536x1024 is ~2-3 MB).
    bytes = await openaiImage(key, { ...base, output_format: "jpeg", output_compression: 85 }, OPENAI_IMAGE_TIMEOUT_MS);
  } catch (e) {
    const status = (e as Error & { status?: number }).status;
    if (status !== 400 || !/output_(format|compression)/i.test(e instanceof Error ? e.message : "")) throw e;
    bytes = await openaiImage(key, base, OPENAI_IMAGE_TIMEOUT_MS);
  }
  if (!sniffType(bytes)) throw new Error("gpt-image-1 returned unreadable bytes");
  return bytes;
}

async function viaDalle3(key: string, prompt: string): Promise<Uint8Array> {
  const bytes = await openaiImage(
    key,
    { model: "dall-e-3", prompt: prompt.slice(0, 3900), size: "1792x1024", quality: "standard", n: 1, response_format: "b64_json" },
    DALLE_TIMEOUT_MS,
  );
  if (!sniffType(bytes)) throw new Error("dall-e-3 returned unreadable bytes");
  return bytes;
}

// ---- The business's own og:image, re-hosted -------------------------------------------------

async function viaOgImage(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`og:image HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || "0");
  if (len > MAX_IMAGE_BYTES) throw new Error("og:image too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < 8_000) throw new Error("og:image too small to use as a hero"); // logos, pixels
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("og:image too large");
  if (!sniffType(bytes)) throw new Error("og:image is not a JPEG/PNG/WebP");
  return bytes;
}

// ---------------------------------------------------------------------------------------------

/** Renders and stores the hero frame. Throws if every source fails (caller keeps a typographic hero).
 *  `model` names what made the image, for events and the CFO line. */
export async function makeHero(
  env: Env,
  biz: Business,
  brand: Brand,
  spec: SiteSpec | null,
): Promise<{ heroImage: string; costCents: number; model: string; prompt: string }> {
  const prompt = heroPrompt(biz, brand, spec);
  const errors: string[] = [];
  let bytes: Uint8Array | null = null;
  let model = "";
  let costCents = 0;
  const note = (e: unknown) => errors.push((e instanceof Error ? e.message : String(e)).slice(0, 140));

  const attempt = async (name: string, cents: number, fn: () => Promise<Uint8Array>) => {
    if (bytes) return;
    try {
      bytes = await fn();
      model = name;
      costCents = cents;
    } catch (e) {
      note(e);
    }
  };

  // 1) Workers AI (skipped entirely while the quota breaker is open).
  if (env.AI && workersAiStatus().ok) {
    await attempt("flux-1-schnell", COST_SCHNELL_CENTS, () => viaSchnell(env, prompt));
    if (workersAiStatus().ok) await attempt("flux-2-klein-4b", COST_KLEIN_CENTS, () => viaKlein(env, prompt));
  } else if (env.AI) {
    errors.push(workersAiStatus().reason || "Workers AI unavailable");
  }

  // 2) OpenAI images.
  const key = openaiKey(env);
  if (key) {
    await attempt("gpt-image-1", COST_GPT_IMAGE_CENTS, () => viaGptImage(key, prompt));
    await attempt("dall-e-3", COST_DALLE3_CENTS, () => viaDalle3(key, prompt));
  }

  // 3) Their own social image, re-hosted so the site never hotlinks.
  const og = getSiteEvidence(biz.id)?.ogImage;
  if (og) await attempt("their og:image", 0, () => viaOgImage(og));

  if (!bytes) throw new Error(errors.join("; ").slice(0, 300) || "no image source available");

  const data: Uint8Array = bytes;
  const contentType = sniffType(data) || "image/jpeg";
  const kvKey = `img:${biz.id}:${Date.now()}`;
  await env.MEDIA.put(kvKey, data, { metadata: { contentType, model, bizId: biz.id } });
  return { heroImage: "/img/" + encodeURIComponent(kvKey), costCents, model, prompt };
}
