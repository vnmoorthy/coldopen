// Stripe integration: webhook signature verification (WebCrypto HMAC-SHA256, no SDK),
// Checkout Session retrieval, and best-effort per-business Payment Links (test mode only).

import type { Env } from "../types";

const API = "https://api.stripe.com/v1";
const TOLERANCE_SECONDS = 300;
const TIMEOUT_MS = 8000;

export const LAUNCH_PACK_CENTS = 4900;

export interface StripeCheckoutSession {
  id: string;
  object: string;
  client_reference_id: string | null;
  payment_status: "paid" | "unpaid" | "no_payment_required" | string;
  status: "open" | "complete" | "expired" | null | string;
  amount_total: number | null;
  currency: string | null;
  livemode?: boolean;
  payment_link?: string | null;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

export type WebhookVerification =
  | { ok: true; event: StripeEvent }
  | { ok: false; error: string };

export type SessionLookup =
  | { ok: true; session: StripeCheckoutSession }
  | { ok: false; error: string; status?: number };

const enc = new TextEncoder();

/** Stripe error messages can echo a masked key (sk_test_****abcd); never let that reach a UI. */
function scrub(message: string): string {
  return message
    .replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, "[redacted key]")
    .replace(/\bwhsec_[A-Za-z0-9*]+/g, "[redacted secret]")
    .slice(0, 300);
}

export function stripeApiEnabled(env: Env): boolean {
  return !!env.STRIPE_SECRET_KEY?.trim();
}

export function stripeWebhookEnabled(env: Env): boolean {
  return !!env.STRIPE_WEBHOOK_SECRET?.trim();
}

/** "test" | "live" | null, from the secret key prefix. */
export function stripeMode(env: Env): "test" | "live" | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return null;
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseSignatureHeader(header: string): { t: number | null; v1: string[] } {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n)) t = n;
    } else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
      v1.push(value.toLowerCase());
    }
  }
  return { t, v1 };
}

/**
 * Verify a Stripe webhook per https://docs.stripe.com/webhooks#verify-manually:
 * signed_payload = `${t}.${rawBody}`, HMAC-SHA256 with the endpoint secret, compare to any v1,
 * and reject timestamps outside a 5 minute tolerance.
 */
export async function verifyWebhook(
  env: Env,
  rawBody: string | ArrayBuffer,
  sigHeader: string | null,
): Promise<WebhookVerification> {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return { ok: false, error: "STRIPE_WEBHOOK_SECRET is not configured" };
  if (!sigHeader) return { ok: false, error: "Missing Stripe-Signature header" };

  const { t, v1 } = parseSignatureHeader(sigHeader);
  if (t === null || v1.length === 0) return { ok: false, error: "Malformed Stripe-Signature header" };

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > TOLERANCE_SECONDS) {
    return { ok: false, error: "Webhook timestamp outside the 5 minute tolerance" };
  }

  const bodyBytes = typeof rawBody === "string" ? enc.encode(rawBody) : new Uint8Array(rawBody);
  const prefix = enc.encode(`${t}.`);
  const signed = new Uint8Array(prefix.length + bodyBytes.length);
  signed.set(prefix, 0);
  signed.set(bodyBytes, prefix.length);

  let expected: string;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    expected = toHex(await crypto.subtle.sign("HMAC", key, signed));
  } catch (err) {
    return { ok: false, error: `Signature computation failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!v1.some((sig) => timingSafeEqualHex(sig, expected))) {
    return { ok: false, error: "Signature mismatch" };
  }

  try {
    const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
    const event = JSON.parse(text) as StripeEvent;
    if (!event || typeof event.type !== "string" || !event.data) {
      return { ok: false, error: "Payload is not a Stripe event" };
    }
    return { ok: true, event };
  } catch {
    return { ok: false, error: "Payload is not valid JSON" };
  }
}

export function isCheckoutSessionId(id: string | null | undefined): id is string {
  return !!id && /^cs_(test|live)_[A-Za-z0-9]{8,200}$/.test(id);
}

/** GET /v1/checkout/sessions/{id} with the secret key. Never throws. */
export async function retrieveSession(env: Env, id: string): Promise<SessionLookup> {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return { ok: false, error: "STRIPE_SECRET_KEY is not configured" };
  if (!isCheckoutSessionId(id)) return { ok: false, error: "Malformed Checkout Session id" };
  try {
    const res = await fetch(`${API}/checkout/sessions/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as
      | (StripeCheckoutSession & { error?: { message?: string } })
      | null;
    if (!res.ok || !body) {
      return { ok: false, status: res.status, error: scrub(body?.error?.message ?? `Stripe responded ${res.status}`) };
    }
    return { ok: true, session: body };
  } catch (err) {
    return { ok: false, error: scrub(`Stripe request failed: ${err instanceof Error ? err.message : String(err)}`) };
  }
}

async function stripePost<T>(
  key: string,
  path: string,
  params: Record<string, string>,
  idempotencyKey: string,
): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
        "Stripe-Version": "2024-06-20",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!res.ok || !body) {
      console.warn(`stripe POST ${path} → ${res.status}: ${scrub(body?.error?.message ?? "no body")}`);
      return null;
    }
    return body;
  } catch (err) {
    console.warn(`stripe POST ${path} failed: ${scrub(err instanceof Error ? err.message : String(err))}`);
    return null;
  }
}

/**
 * Create a dedicated $49 Payment Link named for this business (test mode only, so a demo can
 * never create live charges). Returns the link URL with client_reference_id appended, or null
 * when not possible — callers then fall back to the shared PAYMENT_LINK.
 */
export async function createBusinessPaymentLink(
  env: Env,
  biz: { id: string; name: string },
  publicUrl: string,
): Promise<string | null> {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key || stripeMode(env) !== "test") return null;
  const base = publicUrl.replace(/\/+$/, "");
  const productName = `Cold Open Launch Pack: ${biz.name}`.slice(0, 250);

  const price = await stripePost<{ id: string }>(
    key,
    "/prices",
    {
      currency: "usd",
      unit_amount: String(LAUNCH_PACK_CENTS),
      "product_data[name]": productName,
      "product_data[metadata][business_id]": biz.id,
      "metadata[business_id]": biz.id,
    },
    `coldopen:${biz.id}:price:v1`,
  );
  if (!price?.id) return null;

  const link = await stripePost<{ id: string; url: string }>(
    key,
    "/payment_links",
    {
      "line_items[0][price]": price.id,
      "line_items[0][quantity]": "1",
      "after_completion[type]": "redirect",
      "after_completion[redirect][url]": `${base}/claimed?session_id={CHECKOUT_SESSION_ID}`,
      "metadata[business_id]": biz.id,
      "payment_intent_data[metadata][business_id]": biz.id,
    },
    `coldopen:${biz.id}:link:v1:${price.id}`,
  );
  if (!link?.url) return null;
  return withClientReference(link.url, biz.id);
}

export function withClientReference(link: string, bizId: string): string {
  try {
    const u = new URL(link);
    u.searchParams.set("client_reference_id", bizId);
    return u.toString();
  } catch {
    const sep = link.includes("?") ? "&" : "?";
    return `${link}${sep}client_reference_id=${encodeURIComponent(bizId)}`;
  }
}
