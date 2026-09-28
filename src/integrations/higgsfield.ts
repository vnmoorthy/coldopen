// Higgsfield image-to-video integration (Director agent -> "launch ad" clip).
//
// Implemented against the public Higgsfield API docs (docs.higgsfield.ai, checked 2026-09-28):
//   Base URL        https://api.higgsfield.ai
//   Auth            Authorization: Key {api_key_id}:{api_key_secret}
//   Submit          POST /{model-endpoint-id}  JSON body  ->  { status:"queued", request_id, status_url, cancel_url }
//   Poll            GET  /requests/{request_id}/status  ->  { status, request_id, video?: { url }, error? }
//   Statuses        queued | in_progress | completed | failed | nsfw | canceled
//   Upload          POST /files/generate-upload-url { content_type } -> { public_url, upload_url, upload_headers }
// Submissions are NOT idempotent, so a submit that times out is never retried automatically
// (a retry could render and bill twice).
//
// Every function here throws a HiggsfieldError (an Error subclass) with a human-readable message on
// failure. `err.retryable` tells a polling loop whether trying again later can help.

import type { Brand, Env } from "../types";

export const HIGGSFIELD_API_BASE = "https://api.higgsfield.ai";

const TIMEOUT_MS = 30_000;
const MAX_PROMPT_CHARS = 1_200;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const NEGATIVE_PROMPT =
  "text, captions, subtitles, watermark, logo distortion, warped faces, extra limbs, flicker, jitter, low quality, blurry";

export interface HiggsfieldModel {
  /** Endpoint id, which is also the URL path after the base URL. */
  id: string;
  label: string;
  body(input: { imageUrl: string; prompt: string }): Record<string, unknown>;
}

// Fast image-to-video models, tried in order. The next one is used only when the API says the
// model is unavailable to this account (404 / 423 / 503), never after a timeout or a 4xx on the request.
// Kling 2.5 Turbo Standard is first: it is in Higgsfield's OpenAPI spec, defaults to a 5 s clip and
// is the quickest, cheapest cinematic option in the catalog.
export const HIGGSFIELD_MODELS: HiggsfieldModel[] = [
  {
    id: "kling-video/v2.5-turbo/standard/image-to-video",
    label: "Kling 2.5 Turbo",
    body: ({ imageUrl, prompt }) => ({
      prompt,
      image_url: imageUrl,
      duration: 5,
      cfg_scale: 0.5,
      negative_prompt: NEGATIVE_PROMPT,
    }),
  },
  {
    id: "minimax/hailuo-2.3/standard/image-to-video",
    label: "MiniMax Hailuo 2.3",
    // Hailuo only accepts 6 or 10 seconds.
    body: ({ imageUrl, prompt }) => ({ prompt, image_url: imageUrl, duration: 6, prompt_optimizer: true }),
  },
  {
    id: "kling-video/v3.0-turbo/image-to-video",
    label: "Kling 3.0 Turbo",
    body: ({ imageUrl, prompt }) => ({ prompt, image_url: imageUrl, duration: 5, resolution: "720p" }),
  },
];

export class HiggsfieldError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly correlationId?: string;
  constructor(message: string, opts: { status?: number; retryable?: boolean; correlationId?: string } = {}) {
    super(message);
    this.name = "HiggsfieldError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.correlationId = opts.correlationId;
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * True when Higgsfield credentials are configured. Higgsfield credentials have two parts (key ID and
 * secret): set HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET, or HIGGSFIELD_API_KEY alone as "id:secret"
 * (the format the official SDKs call HF_CREDENTIALS).
 */
export function higgsfieldEnabled(env: Env): boolean {
  const key = clean(env.HIGGSFIELD_API_KEY);
  if (!key) return false;
  return Boolean(clean(env.HIGGSFIELD_API_SECRET)) || key.includes(":");
}

/** Label of the model a new job would use first, e.g. for the agent channel ("Kling 2.5 Turbo via Higgsfield"). */
export function higgsfieldModelLabel(env: Env): string {
  return modelChain(env)[0].label;
}

/**
 * Submit an image-to-video job. `imageUrl` can be absolute, relative to PUBLIC_URL (e.g. "/img/img:abc:1"),
 * or a data: URI. Hero images stored in the MEDIA KV namespace are uploaded straight to Higgsfield
 * storage, so the render never depends on Higgsfield being able to fetch this Worker.
 * Returns the Higgsfield request_id as `jobId` (plus the model used).
 */
export async function startVideo(
  env: Env,
  input: { imageUrl: string; prompt: string },
): Promise<{ jobId: string; model: string; modelLabel: string }> {
  const deadline = Date.now() + TIMEOUT_MS;
  const auth = authHeader(env);
  const prompt = cleanPrompt(input?.prompt);
  if (!prompt) throw new HiggsfieldError("Higgsfield needs a non-empty video prompt.");
  if (!clean(input?.imageUrl)) throw new HiggsfieldError("Higgsfield needs a hero image to animate.");

  const imageUrl = await resolveImageUrl(env, input.imageUrl, auth, deadline);

  const unavailable: string[] = [];
  for (const model of modelChain(env)) {
    const remaining = deadline - Date.now();
    if (remaining < 2_000) break;

    let res: Response;
    try {
      res = await fetch(`${HIGGSFIELD_API_BASE}/${model.id}`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(model.body({ imageUrl, prompt })),
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      // Ambiguous: the job may or may not have been created. Do not resubmit (no idempotency key).
      throw new HiggsfieldError(
        `Higgsfield did not answer the ${model.label} submission in time (${errMessage(err)}). ` +
          "Not retried automatically to avoid a duplicate render.",
        { retryable: false },
      );
    }

    const body = await readJson(res);
    const correlationId = res.headers.get("x-correlation-id") ?? undefined;

    if (res.ok) {
      const jobId = typeof body?.request_id === "string" ? body.request_id : "";
      if (!jobId) {
        throw new HiggsfieldError(`Higgsfield accepted the ${model.label} job but returned no request_id.`, {
          status: res.status,
          correlationId,
        });
      }
      return { jobId, model: model.id, modelLabel: model.label };
    }

    if (res.status === 404 || res.status === 423 || res.status === 503) {
      unavailable.push(`${model.label} (${res.status}${detailOf(body) ? `: ${detailOf(body)}` : ""})`);
      continue; // model not available to this account right now: try the next one
    }

    throw httpError(res.status, body, `submitting ${model.label}`, correlationId);
  }

  throw new HiggsfieldError(
    unavailable.length
      ? `No Higgsfield image-to-video model is available to this account right now: ${unavailable.join("; ")}.`
      : "Higgsfield submission ran out of time before a model accepted the job.",
    { retryable: true },
  );
}

/**
 * Check a job. Job-level outcomes come back as a status ('rendering' | 'ready' | 'error').
 * Transport problems (network, timeout, 5xx, 429) throw a HiggsfieldError with retryable=true;
 * credential or unknown-job problems (401, 404) throw with retryable=false.
 */
export async function pollVideo(
  env: Env,
  jobId: string,
): Promise<{ status: "rendering" | "ready" | "error"; url?: string; error?: string }> {
  const auth = authHeader(env);
  const id = clean(jobId);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw new HiggsfieldError(`Invalid Higgsfield job id "${id.slice(0, 40)}".`);

  let res: Response;
  try {
    res = await fetch(`${HIGGSFIELD_API_BASE}/requests/${encodeURIComponent(id)}/status`, {
      headers: { Authorization: auth, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new HiggsfieldError(`Higgsfield status check failed (${errMessage(err)}).`, { retryable: true });
  }

  const body = await readJson(res);
  if (!res.ok) throw httpError(res.status, body, "checking the render", res.headers.get("x-correlation-id") ?? undefined);

  const status = typeof body?.status === "string" ? body.status : "";
  switch (status) {
    case "queued":
    case "in_progress":
      return { status: "rendering" };
    case "completed": {
      // Documented shape is { video: { url } }. ASSUMPTION: `mov` / `videos` are defensive fallbacks only.
      const url = firstUrl(body?.video) ?? firstUrl(body?.mov) ?? firstUrl(body?.videos);
      if (!url) return { status: "error", error: "Higgsfield finished the render but returned no video URL." };
      return { status: "ready", url };
    }
    case "failed":
      return { status: "error", error: `Higgsfield render failed: ${clean(body?.error) || "no reason given"}.` };
    case "nsfw":
      return { status: "error", error: "Higgsfield content moderation rejected this render (credits are refunded)." };
    case "canceled":
      return { status: "error", error: "The Higgsfield render was canceled." };
    default:
      // Unknown non-terminal state: keep polling rather than failing the video.
      return { status: "rendering" };
  }
}

/**
 * A brand-faithful motion prompt for a hero still. Uses only the brand's own vibe/keywords and
 * the business category: no invented products, people or claims, and no on-screen text.
 */
export function suggestVideoPrompt(brand: Pick<Brand, "name" | "vibe" | "keywords">, category?: string): string {
  const place = clean(category).replace(/_/g, " ") || "local business";
  const vibe = clean(brand?.vibe);
  const words = (brand?.keywords ?? []).map(clean).filter(Boolean).slice(0, 4).join(", ");
  return cleanPrompt(
    `Slow cinematic push-in across this ${place} scene` +
      (vibe ? `, ${vibe}` : "") +
      (words ? `, evoking ${words}` : "") +
      ". Soft natural light, gentle parallax, shallow depth of field, subtle ambient motion such as steam, " +
      "leaves or passers-by. Keep the composition and colors of the source image. No text, no logos, no captions.",
  );
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function cleanPrompt(v: unknown): string {
  const s = clean(v).replace(/\s+/g, " ");
  return s.length > MAX_PROMPT_CHARS ? `${s.slice(0, MAX_PROMPT_CHARS - 1).trimEnd()}…` : s;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" || err.name === "AbortError" ? "timed out" : err.message;
  return String(err);
}

function authHeader(env: Env): string {
  let key = clean(env.HIGGSFIELD_API_KEY).replace(/^Key\s+/i, "");
  const secret = clean(env.HIGGSFIELD_API_SECRET);
  if (!key) throw new HiggsfieldError("Higgsfield key not configured (set HIGGSFIELD_API_KEY).");
  if (secret && !key.includes(":")) key = `${key}:${secret}`;
  if (!key.includes(":")) {
    throw new HiggsfieldError(
      "Higgsfield credentials need a key ID and a secret: set HIGGSFIELD_API_SECRET, or HIGGSFIELD_API_KEY as \"id:secret\".",
    );
  }
  return `Key ${key}`;
}

function modelChain(env: Env): HiggsfieldModel[] {
  // Optional override without touching the Env type: `wrangler.jsonc` vars.HIGGSFIELD_MODEL = "<endpoint id>".
  const override = clean((env as unknown as Record<string, unknown>).HIGGSFIELD_MODEL).replace(/^\/+|\/+$/g, "");
  if (!override || !/^[a-z0-9][a-z0-9._/-]{3,120}$/i.test(override)) return HIGGSFIELD_MODELS;
  const known = HIGGSFIELD_MODELS.find((m) => m.id === override);
  const first: HiggsfieldModel = known ?? {
    id: override,
    label: override,
    // Unknown model: send only the two fields every Higgsfield image-to-video endpoint requires.
    body: ({ imageUrl, prompt }) => ({ prompt, image_url: imageUrl }),
  };
  return [first, ...HIGGSFIELD_MODELS.filter((m) => m.id !== first.id)];
}

async function readJson(res: Response): Promise<any> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** FastAPI error envelope: { detail: string } or { detail: [{ loc, msg }] } for validation errors. */
function detailOf(body: any): string {
  const d = body?.detail;
  if (typeof d === "string") return d.slice(0, 300);
  if (Array.isArray(d)) {
    return d
      .map((x: any) => {
        const loc = Array.isArray(x?.loc) ? x.loc.filter((p: unknown) => p !== "body").join(".") : "";
        return [loc, clean(x?.msg)].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join("; ")
      .slice(0, 300);
  }
  if (d && typeof d === "object") return clean(d.message) || clean(d.error);
  return clean(body?.error).slice(0, 300);
}

function httpError(status: number, body: any, doing: string, correlationId?: string): HiggsfieldError {
  const detail = detailOf(body);
  const suffix = detail ? `: ${detail}` : "";
  const ref = correlationId ? ` [correlation ${correlationId}]` : "";
  let message: string;
  let retryable = false;
  switch (true) {
    case status === 400:
      message = `Higgsfield rejected the request while ${doing}${suffix}`;
      // ASSUMPTION: the docs list "concurrency reached" as a 400 cause; we match it by message text.
      retryable = /concurren/i.test(detail);
      break;
    case status === 401:
      message = "Higgsfield rejected the API credentials (401). Check HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.";
      break;
    case status === 403:
      message = `Higgsfield account is out of credits (403) while ${doing}${suffix}`;
      break;
    case status === 404:
      message = `Higgsfield could not find that job for this account (404) while ${doing}.`;
      break;
    case status === 422:
      message = `Higgsfield validation failed while ${doing}${suffix}`;
      break;
    case status === 423 || status === 503:
      message = `Higgsfield model is temporarily unavailable (${status}) while ${doing}${suffix}`;
      retryable = true;
      break;
    case status === 429:
      message = `Higgsfield rate limit hit (429) while ${doing}. Try again shortly.`;
      retryable = true;
      break;
    case status >= 500:
      message = `Higgsfield server error (${status}) while ${doing}${suffix}`;
      retryable = true;
      break;
    default:
      message = `Higgsfield returned HTTP ${status} while ${doing}${suffix}`;
  }
  return new HiggsfieldError(message + ref, { status, retryable, correlationId });
}

function firstUrl(v: any): string | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return firstUrl(v[0]);
  return typeof v.url === "string" && /^https?:\/\//i.test(v.url) ? v.url : undefined;
}

function safeUrl(s: string | undefined): URL | null {
  try {
    return s ? new URL(s) : null;
  } catch {
    return null;
  }
}

/** Produce a public HTTPS URL Higgsfield can read. */
async function resolveImageUrl(env: Env, raw: string, auth: string, deadline: number): Promise<string> {
  const s = raw.trim();

  if (s.startsWith("data:")) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(s);
    if (!m) throw new HiggsfieldError("Hero image data URI must be base64-encoded image data.");
    const bytes = base64ToBytes(m[2]);
    const type = sniffImageType(bytes) ?? normalizeType(m[1]);
    if (!type) throw new HiggsfieldError(`Higgsfield does not accept ${m[1]} images (use JPEG, PNG, WebP or GIF).`);
    return uploadBytes(bytes, type, auth, deadline);
  }

  const base = safeUrl(env.PUBLIC_URL);
  let url: URL;
  try {
    url = base ? new URL(s, base) : new URL(s);
  } catch {
    throw new HiggsfieldError(`Hero image URL "${s.slice(0, 80)}" is not a valid URL.`);
  }

  // Our own KV-backed hero image (served by GET /img/:key): upload the bytes directly.
  // ASSUMPTION: the path segment after /img/ is the (URI-encoded) MEDIA KV key, per SPEC ("/img/<kv-key>").
  if (base && url.host === base.host && url.pathname.startsWith("/img/") && env.MEDIA) {
    try {
      const key = decodeURIComponent(url.pathname.slice("/img/".length));
      const buf = key ? await env.MEDIA.get(key, "arrayBuffer") : null;
      if (buf && buf.byteLength > 0 && buf.byteLength <= MAX_UPLOAD_BYTES) {
        const bytes = new Uint8Array(buf);
        const type = sniffImageType(bytes);
        if (type) return await uploadBytes(bytes, type, auth, deadline);
      }
    } catch (err) {
      // Fall back to the public URL below.
      console.warn(`[higgsfield] direct upload failed, using public image URL instead: ${errMessage(err)}`);
    }
  }

  if (url.protocol !== "https:") {
    throw new HiggsfieldError("Higgsfield needs a public HTTPS image URL (set PUBLIC_URL to the deployed https origin).");
  }
  if (/^(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(url.hostname)) {
    throw new HiggsfieldError("Higgsfield cannot fetch images from a private or localhost address.");
  }
  return url.toString();
}

async function uploadBytes(bytes: Uint8Array, contentType: string, auth: string, deadline: number): Promise<string> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HiggsfieldError("Hero image is too large to upload (max 10 MB).");

  let res: Response;
  try {
    res = await fetch(`${HIGGSFIELD_API_BASE}/files/generate-upload-url`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ content_type: contentType }),
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(10_000, deadline - Date.now()))),
    });
  } catch (err) {
    throw new HiggsfieldError(`Higgsfield upload URL request failed (${errMessage(err)}).`, { retryable: true });
  }
  const body = await readJson(res);
  if (!res.ok) throw httpError(res.status, body, "preparing the image upload", res.headers.get("x-correlation-id") ?? undefined);

  const uploadUrl = clean(body?.upload_url);
  const publicUrl = clean(body?.public_url);
  if (!uploadUrl || !publicUrl) throw new HiggsfieldError("Higgsfield returned an incomplete upload URL response.");

  // Send every header Higgsfield returned, and never our credentials, to the presigned storage URL.
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (body?.upload_headers && typeof body.upload_headers === "object") {
    for (const [k, v] of Object.entries(body.upload_headers)) if (typeof v === "string") headers[k] = v;
  }

  let put: Response;
  try {
    put = await fetch(uploadUrl, {
      method: "PUT",
      headers,
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(15_000, deadline - Date.now()))),
    });
  } catch (err) {
    throw new HiggsfieldError(`Uploading the hero image to Higgsfield failed (${errMessage(err)}).`, { retryable: true });
  }
  if (!put.ok) throw new HiggsfieldError(`Uploading the hero image to Higgsfield failed (HTTP ${put.status}).`, { status: put.status, retryable: put.status >= 500 });
  return publicUrl;
}

function normalizeType(t: string): string | null {
  const v = t.toLowerCase();
  if (v === "image/jpg") return "image/jpeg";
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(v) ? v : null;
}

function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64.replace(/\s+/g, ""));
  } catch {
    throw new HiggsfieldError("Hero image data URI is not valid base64.");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
