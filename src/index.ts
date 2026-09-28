// Cold Open Worker entry.
//   /agents/*  → Agents SDK (WebSocket to the HQ agent, instance "main")
//   /api/*     → HQ agent onRequest (all JSON API routes)
//   /s/:id     → generated concept sites (+ /claim → Stripe, /remove → owner opt-out)
//   /claimed   → post-checkout thank-you + payment attribution
//   /img/:key  → hero images from KV
//   else       → static Mission Control (public/)

import { getAgentByName, routeAgentRequest } from "agents";
import { HQ, INTERNAL_HEADER } from "./hq";
import type { Business, Env } from "./types";
import { renderClaimed, renderNotFound, renderRemoveConfirm, renderRemoved, renderSite } from "./site/render";

export { HQ };

const ID_RE = /^[a-z0-9-]{1,80}$/;

// ─── response helpers ────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function htmlResponse(html: string, status = 200, extra?: Record<string, string>): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Minimal branded page for states render.ts doesn't cover (still building, server error). */
function statusPage(opts: { title: string; heading: string; body: string; refreshSeconds?: number; home?: string }): string {
  const refresh = opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">${refresh}
<title>${esc(opts.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Inter:wght@400;500&family=JetBrains+Mono&display=swap" rel="stylesheet">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0A0A0B;color:#F4F1EA;font:16px/1.55 Inter,system-ui,sans-serif;padding:24px}
  main{max-width:560px;text-align:left}
  .mark{font:12px/1 "JetBrains Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:#FF5B1F;margin-bottom:28px;display:flex;gap:10px;align-items:center}
  .dot{width:8px;height:8px;border-radius:50%;background:#FF5B1F;box-shadow:0 0 0 0 rgba(255,91,31,.6);animation:p 1.6s infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 rgba(255,91,31,.55)}70%{box-shadow:0 0 0 12px rgba(255,91,31,0)}100%{box-shadow:0 0 0 0 rgba(255,91,31,0)}}
  h1{font:400 clamp(36px,7vw,56px)/1.05 "Instrument Serif",Georgia,serif;margin:0 0 16px}
  p{color:#8A877F;margin:0 0 24px}
  a{color:#F4F1EA;text-underline-offset:3px}
  @media (prefers-reduced-motion:reduce){.dot{animation:none}}
</style></head>
<body><main>
  <div class="mark"><span class="dot"></span>Cold Open</div>
  <h1>${esc(opts.heading)}</h1>
  <p>${opts.body}</p>
  ${opts.home ? `<p><a href="${esc(opts.home)}">Cold Open Mission Control →</a></p>` : ""}
</main></body></html>`;
}

const STATUS_WORDS: Partial<Record<Business["status"], string>> = {
  scouted: "is queued for a build",
  extracting: "is reading the brand",
  building: "is composing the site",
  critiquing: "is in front of the taste critic",
  directing: "is directing the hero frame",
  error: "hit a snag while building",
};

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ─── HQ access ───────────────────────────────────────────────────────────────

async function hqStub(env: Env) {
  return getAgentByName(env.HQ as unknown as DurableObjectNamespace<HQ>, "main");
}

async function forwardApi(request: Request, env: Env): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_HEADER);
  const stub = await hqStub(env);
  return stub.fetch(new Request(request, { headers }));
}

async function internal<T>(
  env: Env,
  path: string,
  init: { method?: string; body?: unknown; ua?: string } = {},
): Promise<{ status: number; data: T | null }> {
  const stub = await hqStub(env);
  const headers: Record<string, string> = { [INTERNAL_HEADER]: "1", "x-co-ua": init.ua ?? "" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await stub.fetch(
    new Request(`https://hq.internal${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
  );
  const data = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, data };
}

// ─── /s/:id … ────────────────────────────────────────────────────────────────

async function handleSite(request: Request, env: Env, url: URL): Promise<Response> {
  const m = url.pathname.match(/^\/s\/([^/]+)(?:\/(claim|remove))?\/?$/);
  const id = m?.[1] ? m[1].toLowerCase() : "";
  if (!m || !ID_RE.test(id)) return htmlResponse(renderNotFound(), 404);
  const action = m[2] ?? "";
  const method = request.method.toUpperCase();
  const publicUrl = url.origin;
  const ua = request.headers.get("user-agent") ?? "";

  if (!action) {
    if (method !== "GET" && method !== "HEAD") return htmlResponse(renderNotFound(), 405, { allow: "GET, HEAD" });
    const r = await internal<{ business: Business }>(env, `/api/_internal/site/${id}${method === "GET" ? "?view=1" : ""}`, { ua });
    const biz = r.data?.business;
    if (r.status === 404 || !biz) return htmlResponse(renderNotFound(), 404);
    if (biz.status === "removed") return htmlResponse(renderRemoved(biz.name), 410);
    if (!biz.site || !biz.brand) {
      const words = STATUS_WORDS[biz.status] ?? "is being built";
      const errored = biz.status === "error";
      return htmlResponse(
        statusPage({
          title: `${biz.name} · Cold Open`,
          heading: errored ? `${biz.name}'s preview isn't ready.` : `${biz.name}'s preview is on the way.`,
          body: errored
            ? `The build ${words}. The team at Cold Open has been notified in Mission Control and can rebuild it.`
            : `Cold Open ${words} right now. This page refreshes itself — it usually takes under a minute.`,
          refreshSeconds: errored ? undefined : 5,
          home: publicUrl,
        }),
        200,
      );
    }
    return htmlResponse(renderSite(biz, { publicUrl }), 200);
  }

  if (action === "claim") {
    if (method !== "GET" && method !== "HEAD") return htmlResponse(renderNotFound(), 405, { allow: "GET" });
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
    const r = await internal<{ business: Business; paymentUrl: string | null }>(env, `/api/_internal/claim/${id}`, {
      method: "POST",
      ua,
    });
    const biz = r.data?.business;
    if (r.status === 404 || !biz) return htmlResponse(renderNotFound(), 404);
    if (biz.status === "removed") return htmlResponse(renderRemoved(biz.name), 410);
    const target = r.data?.paymentUrl;
    if (!target) {
      return htmlResponse(
        statusPage({
          title: "Checkout unavailable · Cold Open",
          heading: "Checkout isn't wired up yet.",
          body: "This preview doesn't have a payment link configured. Please reply to the email you received and we'll sort it out by hand.",
          home: publicUrl,
        }),
        503,
      );
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: target,
        "set-cookie": `co_claim=${encodeURIComponent(id)}; Path=/; Max-Age=3600; SameSite=Lax; Secure; HttpOnly`,
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  // action === "remove"
  if (method === "GET" || method === "HEAD") {
    const r = await internal<{ business: Business }>(env, `/api/_internal/site/${id}`);
    const biz = r.data?.business;
    if (r.status === 404 || !biz) return htmlResponse(renderNotFound(), 404);
    if (biz.status === "removed") return htmlResponse(renderRemoved(biz.name), 410);
    return htmlResponse(renderRemoveConfirm(biz), 200);
  }
  if (method === "POST") {
    const r = await internal<{ ok: boolean; name?: string }>(env, `/api/_internal/remove/${id}`, { method: "POST", body: {} });
    if (r.status === 404) return htmlResponse(renderNotFound(), 404);
    return htmlResponse(renderRemoved(r.data?.name), 200);
  }
  return htmlResponse(renderNotFound(), 405, { allow: "GET, POST" });
}

// ─── /claimed ────────────────────────────────────────────────────────────────

async function handleClaimed(request: Request, env: Env, url: URL): Promise<Response> {
  const publicUrl = url.origin;
  const method = request.method.toUpperCase();
  if (method === "HEAD") return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  if (method !== "GET") return htmlResponse(renderNotFound(), 405, { allow: "GET" });

  const rawSession = url.searchParams.get("session_id");
  const sessionId = rawSession && rawSession !== "{CHECKOUT_SESSION_ID}" ? rawSession.slice(0, 255) : null;
  const cookie = parseCookie(request.headers.get("cookie"), "co_claim");
  const cookieId = cookie && ID_RE.test(cookie) ? cookie : null;

  const r = await internal<{ business: Business | null; verified: boolean; paid: boolean }>(env, "/api/_internal/claimed", {
    method: "POST",
    body: { sessionId, cookieId },
  });
  const biz = r.data?.business ?? null;
  const verified = !!r.data?.verified;
  const res = htmlResponse(renderClaimed(biz, { verified, publicUrl }), 200);
  if (biz && cookieId) {
    res.headers.append("set-cookie", "co_claim=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly");
  }
  return res;
}

// ─── /img/:key ───────────────────────────────────────────────────────────────

function sniffImageType(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  return "application/octet-stream";
}

async function handleImage(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice("/img/".length));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!key || key.length > 512) return new Response("Not found", { status: 404 });

  const { value, metadata } = await env.MEDIA.getWithMetadata<Record<string, unknown>>(key, "arrayBuffer");
  if (!value) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const metaType =
    (typeof metadata?.contentType === "string" && metadata.contentType) ||
    (typeof metadata?.["content-type"] === "string" && (metadata["content-type"] as string)) ||
    (typeof metadata?.type === "string" && (metadata.type as string)) ||
    "";
  const contentType = metaType.startsWith("image/") || metaType.startsWith("video/") ? metaType : sniffImageType(value);
  return new Response(method === "HEAD" ? null : value, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(value.byteLength),
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  });
}

// ─── entry ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/agents" || path.startsWith("/agents/")) {
        const headers = new Headers(request.headers);
        headers.delete(INTERNAL_HEADER);
        const routed = await routeAgentRequest(new Request(request, { headers }), env);
        return routed ?? jsonResponse({ error: "Not found" }, 404);
      }
      if (path === "/api" || path.startsWith("/api/")) return await forwardApi(request, env);
      if (path.startsWith("/s/")) return await handleSite(request, env, url);
      if (path === "/claimed" || path === "/claimed/") return await handleClaimed(request, env, url);
      if (path.startsWith("/img/")) return await handleImage(request, env, url);
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error(`worker error on ${request.method} ${path}: ${errMsg(err)}`);
      if (path.startsWith("/api/") || path.startsWith("/agents/")) {
        return jsonResponse({ error: `Worker error: ${errMsg(err)}` }, 500);
      }
      return htmlResponse(
        statusPage({
          title: "Something went wrong · Cold Open",
          heading: "Something went wrong.",
          body: "Cold Open hit an unexpected error serving this page. Refresh in a moment.",
          home: url.origin,
        }),
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
