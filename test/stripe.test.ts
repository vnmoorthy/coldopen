import { describe, expect, it } from "vitest";
import {
  LAUNCH_PACK_CENTS,
  createBusinessPaymentLink,
  isCheckoutSessionId,
  retrieveSession,
  stripeMode,
  verifyWebhook,
  withClientReference,
} from "../src/integrations/stripe";
import { jsonResponse, makeEnv, stubFetch } from "./fixtures";

// A made-up endpoint secret, only ever used inside these tests.
const SECRET = "whsec_unit_test_secret_do_not_use";
const env = makeEnv({ STRIPE_WEBHOOK_SECRET: SECRET });

const EVENT = {
  id: "evt_test_1",
  type: "checkout.session.completed",
  created: 1_790_000_000,
  livemode: false,
  data: { object: { id: "cs_test_abc12345", client_reference_id: "harbor-lane-coffee", amount_total: 4900 } },
};
const BODY = JSON.stringify(EVENT);

/** Signs `${t}.${body}` the way Stripe documents it (HMAC-SHA256, lowercase hex). */
async function sign(body: string, t: number, secret = SECRET): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

const now = () => Math.floor(Date.now() / 1000);

describe("verifyWebhook", () => {
  it("accepts a correctly signed, fresh event", async () => {
    const t = now();
    const res = await verifyWebhook(env, BODY, `t=${t},v1=${await sign(BODY, t)}`);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.event.type).toBe("checkout.session.completed");
      expect(res.event.data.object.client_reference_id).toBe("harbor-lane-coffee");
    }
  });

  it("accepts the raw body as an ArrayBuffer", async () => {
    const t = now();
    const buf = new TextEncoder().encode(BODY).buffer as ArrayBuffer;
    const res = await verifyWebhook(env, buf, `t=${t},v1=${await sign(BODY, t)}`);
    expect(res.ok).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const t = now();
    const sig = await sign(BODY, t);
    const tampered = BODY.replace('"amount_total":4900', '"amount_total":1');
    expect(tampered).not.toBe(BODY);
    expect(await verifyWebhook(env, tampered, `t=${t},v1=${sig}`)).toEqual({ ok: false, error: "Signature mismatch" });
  });

  it("rejects a signature made with a different secret", async () => {
    const t = now();
    const res = await verifyWebhook(env, BODY, `t=${t},v1=${await sign(BODY, t, "whsec_someone_else")}`);
    expect(res).toEqual({ ok: false, error: "Signature mismatch" });
  });

  it("rejects an expired timestamp even when the signature is valid (replay protection)", async () => {
    const t = now() - 301;
    const res = await verifyWebhook(env, BODY, `t=${t},v1=${await sign(BODY, t)}`);
    expect(res).toEqual({ ok: false, error: "Webhook timestamp outside the 5 minute tolerance" });
  });

  it("rejects a timestamp too far in the future", async () => {
    const t = now() + 600;
    const res = await verifyWebhook(env, BODY, `t=${t},v1=${await sign(BODY, t)}`);
    expect(res.ok).toBe(false);
  });

  it("rejects a valid signature replayed with a different timestamp", async () => {
    const signedAt = now() - 10;
    const sig = await sign(BODY, signedAt);
    expect(await verifyWebhook(env, BODY, `t=${signedAt + 1},v1=${sig}`)).toEqual({ ok: false, error: "Signature mismatch" });
  });

  it("accepts when any of several v1 signatures matches (secret rotation)", async () => {
    const t = now();
    const header = `t=${t},v1=${"0".repeat(64)},v1=${await sign(BODY, t)}`;
    expect((await verifyWebhook(env, BODY, header)).ok).toBe(true);
  });

  it("rejects missing configuration, missing and malformed headers", async () => {
    expect(await verifyWebhook(makeEnv(), BODY, "t=1,v1=abc")).toEqual({ ok: false, error: "STRIPE_WEBHOOK_SECRET is not configured" });
    expect(await verifyWebhook(env, BODY, null)).toEqual({ ok: false, error: "Missing Stripe-Signature header" });
    expect(await verifyWebhook(env, BODY, "garbage")).toEqual({ ok: false, error: "Malformed Stripe-Signature header" });
    // v0 (test scheme) signatures and non-hex values are ignored, so this has no usable v1.
    expect(await verifyWebhook(env, BODY, `t=${now()},v0=${"a".repeat(64)},v1=not-hex`)).toEqual({
      ok: false,
      error: "Malformed Stripe-Signature header",
    });
  });

  it("rejects correctly signed payloads that are not Stripe events", async () => {
    const t = now();
    expect(await verifyWebhook(env, "not json", `t=${t},v1=${await sign("not json", t)}`)).toEqual({
      ok: false,
      error: "Payload is not valid JSON",
    });
    const notEvent = JSON.stringify({ hello: "world" });
    expect(await verifyWebhook(env, notEvent, `t=${t},v1=${await sign(notEvent, t)}`)).toEqual({
      ok: false,
      error: "Payload is not a Stripe event",
    });
  });
});

describe("Stripe helpers", () => {
  it("detects test vs live mode from the key prefix", () => {
    expect(stripeMode(makeEnv({ STRIPE_SECRET_KEY: "sk_test_x" }))).toBe("test");
    expect(stripeMode(makeEnv({ STRIPE_SECRET_KEY: "rk_test_x" }))).toBe("test");
    expect(stripeMode(makeEnv({ STRIPE_SECRET_KEY: "sk_live_x" }))).toBe("live");
    expect(stripeMode(makeEnv({ STRIPE_SECRET_KEY: "pk_test_x" }))).toBeNull(); // publishable keys are not secret keys
    expect(stripeMode(makeEnv())).toBeNull();
  });

  it("validates Checkout Session ids", () => {
    expect(isCheckoutSessionId("cs_test_a1B2c3D4e5")).toBe(true);
    expect(isCheckoutSessionId("cs_live_a1B2c3D4e5")).toBe(true);
    expect(isCheckoutSessionId("cs_test_short")).toBe(false);
    expect(isCheckoutSessionId("pi_test_a1B2c3D4e5")).toBe(false);
    expect(isCheckoutSessionId("cs_test_../../etc")).toBe(false);
    expect(isCheckoutSessionId(null)).toBe(false);
  });

  it("appends client_reference_id to payment links", () => {
    expect(withClientReference("https://buy.stripe.com/test_abc", "harbor")).toBe("https://buy.stripe.com/test_abc?client_reference_id=harbor");
    expect(withClientReference("https://buy.stripe.com/test_abc?locale=en", "harbor")).toBe(
      "https://buy.stripe.com/test_abc?locale=en&client_reference_id=harbor",
    );
    expect(withClientReference("https://buy.stripe.com/x?client_reference_id=old", "new")).toBe("https://buy.stripe.com/x?client_reference_id=new");
  });

  it("prices the launch pack at $49", () => {
    expect(LAUNCH_PACK_CENTS).toBe(4900);
  });
});

describe("createBusinessPaymentLink", () => {
  const biz = { id: "harbor-lane-coffee", name: "Harbor Lane Coffee" };

  it("refuses to create anything with a live key (demo can never charge real money)", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    expect(await createBusinessPaymentLink(makeEnv({ STRIPE_SECRET_KEY: "sk_live_x" }), biz, "https://co.example")).toBeNull();
    expect(await createBusinessPaymentLink(makeEnv(), biz, "https://co.example")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("creates a $49 price and a payment link that redirects to /claimed (stubbed API)", async () => {
    const { calls } = stubFetch((c) =>
      c.url.endsWith("/prices")
        ? jsonResponse({ id: "price_123" })
        : jsonResponse({ id: "plink_123", url: "https://buy.stripe.com/test_abc" }),
    );
    const link = await createBusinessPaymentLink(makeEnv({ STRIPE_SECRET_KEY: "sk_test_fake" }), biz, "https://co.example/");
    expect(link).toBe("https://buy.stripe.com/test_abc?client_reference_id=harbor-lane-coffee");
    expect(calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/prices", "https://api.stripe.com/v1/payment_links"]);

    const price = new URLSearchParams(calls[0].body!);
    expect(price.get("unit_amount")).toBe("4900");
    expect(price.get("currency")).toBe("usd");
    expect(price.get("product_data[name]")).toBe("Cold Open Launch Pack: Harbor Lane Coffee");
    expect(calls[0].headers["idempotency-key"]).toBe("coldopen:harbor-lane-coffee:price:v1");

    const plink = new URLSearchParams(calls[1].body!);
    expect(plink.get("line_items[0][price]")).toBe("price_123");
    expect(plink.get("after_completion[redirect][url]")).toBe("https://co.example/claimed?session_id={CHECKOUT_SESSION_ID}");
  });

  it("returns null (so callers fall back to the shared link) when Stripe errors", async () => {
    stubFetch(() => jsonResponse({ error: { message: "nope" } }, 400));
    expect(await createBusinessPaymentLink(makeEnv({ STRIPE_SECRET_KEY: "sk_test_fake" }), biz, "https://co.example")).toBeNull();
  });
});

describe("retrieveSession", () => {
  it("rejects malformed ids without calling Stripe", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    const res = await retrieveSession(makeEnv({ STRIPE_SECRET_KEY: "sk_test_fake" }), "cs_nope");
    expect(res).toEqual({ ok: false, error: "Malformed Checkout Session id" });
    expect(calls).toHaveLength(0);
  });

  it("redacts keys that Stripe echoes back in error messages", async () => {
    stubFetch(() => jsonResponse({ error: { message: "Invalid API Key provided: sk_test_****abcd" } }, 401));
    const res = await retrieveSession(makeEnv({ STRIPE_SECRET_KEY: "sk_test_fake" }), "cs_test_a1B2c3D4e5");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toContain("[redacted key]");
      expect(res.error).not.toContain("sk_test_");
    }
  });

  it("returns the session on success", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ id: "cs_test_a1B2c3D4e5", object: "checkout.session", client_reference_id: "harbor", payment_status: "paid", status: "complete", amount_total: 4900, currency: "usd" }),
    );
    const res = await retrieveSession(makeEnv({ STRIPE_SECRET_KEY: "sk_test_fake" }), "cs_test_a1B2c3D4e5");
    expect(res.ok && res.session.payment_status).toBe("paid");
    expect(calls[0].headers["authorization"]).toBe("Bearer sk_test_fake");
  });
});
