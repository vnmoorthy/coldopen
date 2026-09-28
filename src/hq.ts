// HQ: the Cold Open mission-control agent (one Durable Object, instance "main").
//
// Owns all state (businesses + agent events in SQLite), serves every /api/* route, runs the
// per-business pipeline (Archivist → Builder ⇄ Critic → Director → Closer), and broadcasts
// everything live to Mission Control over the Agents SDK WebSocket.

import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import type {
  AgentEvent,
  AgentName,
  Brand,
  Business,
  BizStatus,
  Env,
  ScoreVersion,
  SiteSpec,
  Snapshot,
  Stats,
} from "./types";
import { scoutNearby, findByName, type ScoutedPlace } from "./pipeline/scout";
import { extractBrand } from "./pipeline/brand";
import { composeSite } from "./pipeline/builder";
import { critique } from "./pipeline/critic";
import { makeHero } from "./pipeline/director";
import { writePitch } from "./pipeline/closer";
import { higgsfieldEnabled, startVideo, pollVideo, suggestVideoPrompt } from "./integrations/higgsfield";
import { tasteEnabled } from "./integrations/taste";
import { brainbaseEnabled, reviewSite, BRAINBASE_HARNESS, lastBrainbaseError } from "./integrations/brainbase";
import { llmProviderLabel, takeCost, workersAiStatus } from "./llm";
import { isAnthropicKey, openaiEnabled } from "./integrations/openai";
import { notifySlack, slackEnabled, slackLink } from "./integrations/slack";
import {
  LAUNCH_PACK_CENTS,
  createBusinessPaymentLink,
  isCheckoutSessionId,
  retrieveSession,
  stripeApiEnabled,
  stripeMode,
  stripeWebhookEnabled,
  verifyWebhook,
  withClientReference,
  type StripeCheckoutSession,
  type StripeEvent,
} from "./integrations/stripe";

// ─── Tunables ────────────────────────────────────────────────────────────────

const TASTE_BAR = 85;
const MAX_VERSIONS = 3;
const BLOCK_CONCURRENCY = 3;
const EVENTS_KEPT = 1000;
const SNAPSHOT_EVENTS = 200;
const WS_SNAPSHOT_MAX_BYTES = 900_000;
const VIDEO_POLL_SECONDS = 15;
const VIDEO_MAX_MS = 10 * 60_000;
const NAME_LOOKUP_TIMEOUT_MS = 15_000;
const SCOUT_TIMEOUT_MS = 70_000;
const VIEW_EVENT_THROTTLE_MS = 45_000;
const CLAIM_EVENT_THROTTLE_MS = 20_000;

type Stage = "archivist" | "builder" | "critic" | "director" | "closer";

const STAGE_TIMEOUT_MS: Record<Stage, number> = {
  archivist: 90_000,
  builder: 120_000,
  critic: 90_000,
  director: 120_000,
  closer: 90_000,
};

const STAGE_AGENT: Record<Stage, AgentName> = {
  archivist: "Archivist",
  builder: "Builder",
  critic: "Critic",
  director: "Director",
  closer: "Closer",
};

const TRANSIENT: ReadonlySet<BizStatus> = new Set<BizStatus>(["extracting", "building", "critiquing", "directing"]);
const BUILT: ReadonlySet<BizStatus> = new Set<BizStatus>(["ready", "contacted", "replied", "paid"]);

export const INTERNAL_HEADER = "x-coldopen-internal";
const HQ_LABEL = "Cloudflare HQ · 101 Townsend St";

// ─── Small helpers ───────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown inside a pipeline when the business was removed / board reset mid-run. */
class PipelineAbort extends Error {
  constructor() {
    super("pipeline aborted");
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  const msg = (raw || "unknown error").replace(/\s+/g, " ").trim();
  return msg.length > 240 ? `${msg.slice(0, 237)}…` : msg;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Model spend is tiny; show sub-cent precision instead of a misleading $0.00. */
function fmtSpend(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "$0.00";
  if (cents < 1) return `${cents.toFixed(2)}¢`;
  if (cents < 100) return `${cents.toFixed(1)}¢`;
  return fmtMoney(cents);
}

/** Model spend is fractions of a cent per call; keep 4 decimals so sums stay honest. */
function round4(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 10_000) / 10_000;
}

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".") || u.hostname.length > 253) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "business";
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function stripPeriod(s: string): string {
  return s.trim().replace(/[.;\s]+$/, "");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text().catch(() => "");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}

/** "claude-sonnet-5" → "Claude Sonnet 5", "workers-ai:llama-3.3-70b" → "Workers AI · Llama 3.3 70B". */
function prettyModel(raw: string): string {
  const label = (raw || "").trim();
  const claude = label.match(/^claude-([a-z]+)-(\d+(?:-\d+)?)(?:-\d{8})?$/i);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2].replace("-", ".")}`;
  if (/^claude/i.test(label)) return `Claude (${label})`;
  const wai = label.match(/^workers-ai:(.+)$/i);
  if (wai) {
    const m = wai[1];
    const llama = m.match(/^llama-(\d+(?:\.\d+)?)-(\d+)b/i);
    return `Workers AI · ${llama ? `Llama ${llama[1]} ${llama[2]}B` : m}`;
  }
  if (/^workers-ai$/i.test(label)) return "Workers AI";
  return label || "Workers AI";
}

const BOT_UA = /bot|crawler|spider|slurp|facebookexternalhit|embedly|preview|unfurl|whatsapp|telegram|discord|curl|wget|python-requests|headless/i;

// ─── The agent ───────────────────────────────────────────────────────────────

export class HQ extends Agent<Env> {
  private cache: Map<string, Business> | null = null;
  private schemaReady = false;
  /** bizId → run token of the pipeline currently executing for it. */
  private running = new Map<string, number>();
  /** bizIds waiting in a run-block queue. */
  private queued = new Set<string>();
  /** bizIds belonging to an active run-block (their Slack pings are batched). */
  private blockMembers = new Set<string>();
  /** Bumped on reset; in-flight work from an older epoch aborts itself. */
  private epoch = 0;
  private runSeq = 0;
  private scouting = false;
  private eventsSinceTrim = 0;
  private lastViewEvent = new Map<string, number>();
  private lastClaimEvent = new Map<string, number>();

  // ── lifecycle ──

  async onStart(): Promise<void> {
    this.ensureSchema();
    this.recoverInterrupted();
  }

  onConnect(connection: Connection, _ctx: ConnectionContext): void {
    this.ensureSchema();
    this.sendSnapshot(connection);
  }

  onMessage(connection: Connection, message: WSMessage): void {
    if (typeof message !== "string") return;
    let msg: { type?: unknown } | null = null;
    try {
      msg = JSON.parse(message) as { type?: unknown };
    } catch {
      return;
    }
    if (msg?.type === "ping") {
      try {
        connection.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      } catch {
        /* socket went away */
      }
    } else if (msg?.type === "snapshot" || msg?.type === "resync") {
      this.sendSnapshot(connection);
    }
  }

  // ── storage ──

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS co_businesses (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS co_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      biz_id TEXT,
      json TEXT NOT NULL
    )`;
    this.schemaReady = true;
  }

  private businesses(): Map<string, Business> {
    if (this.cache) return this.cache;
    this.ensureSchema();
    const map = new Map<string, Business>();
    const rows = this.sql<{ id: string; json: string }>`SELECT id, json FROM co_businesses ORDER BY created_at ASC`;
    for (const row of rows) {
      try {
        const b = JSON.parse(row.json) as Business;
        if (b && b.id) {
          b.video ??= { status: "none" };
          b.scores ??= [];
          b.timings ??= {};
          b.osmTags ??= {};
          map.set(b.id, b);
        }
      } catch (err) {
        console.error(`skipping corrupt business row ${row.id}: ${errMsg(err)}`);
      }
    }
    this.cache = map;
    return map;
  }

  private get(id: string): Business | null {
    return this.businesses().get(id) ?? null;
  }

  private persist(b: Business): void {
    this.sql`INSERT INTO co_businesses (id, json, created_at, updated_at)
      VALUES (${b.id}, ${JSON.stringify(b)}, ${b.createdAt}, ${b.updatedAt})
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`;
    this.businesses().set(b.id, b);
  }

  /**
   * Merge changes onto the *latest* copy of a business (never a stale one held across an
   * await), persist, and broadcast the business + fresh stats.
   */
  private update(id: string, change: Partial<Business> | ((b: Business) => Partial<Business>)): Business | null {
    const cur = this.get(id);
    if (!cur) return null;
    const partial = typeof change === "function" ? change(cur) : change;
    const next: Business = { ...cur, ...partial, id: cur.id, createdAt: cur.createdAt, updatedAt: Date.now() };
    this.persist(next);
    if (next.status === "removed") this.send({ type: "removed", id });
    else this.send({ type: "business", business: next });
    this.send({ type: "stats", stats: this.computeStats() });
    return next;
  }

  private insert(b: Business): Business {
    this.persist(b);
    this.send({ type: "business", business: b });
    return b;
  }

  private recoverInterrupted(): void {
    let n = 0;
    const resume: string[] = [];
    for (const b of this.businesses().values()) {
      if (!TRANSIENT.has(b.status)) continue;
      n++;
      resume.push(b.id);
      this.persist({
        ...b,
        status: "error",
        error: "Build interrupted by a server restart — resuming automatically.",
        updatedAt: Date.now(),
      });
    }
    if (resume.length) {
      // Self-heal: a durable alarm (not setTimeout, which dies if the object is evicted) picks the
      // interrupted builds back up once the object has finished starting.
      this.schedule(2, "resumeInterrupted", { ids: resume.slice(0, 6) }).catch((e: unknown) => {
        console.warn(`[hq] could not schedule resume: ${e instanceof Error ? e.message : e}`);
      });
    }
    const hasEvents = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM co_events`[0]?.n ?? 0;
    if (!hasEvents) {
      this.emit("System", "info", `HQ online at 101 Townsend St. ${this.integrationLine()}`);
    } else if (n > 0) {
      this.emit(
        "System",
        "warn",
        `Back after a restart — ${plural(n, "build was", "builds were")} interrupted mid-flight. Resuming ${n === 1 ? "it" : "them"} now.`,
      );
    }
  }

  // ── broadcast + events ──

  private send(msg: unknown): void {
    try {
      this.broadcast(JSON.stringify(msg));
    } catch (err) {
      console.warn(`broadcast failed: ${errMsg(err)}`);
    }
  }

  private sendSnapshot(connection: Connection): void {
    try {
      let payload = JSON.stringify({ type: "snapshot", snapshot: this.snapshot() });
      if (payload.length > WS_SNAPSHOT_MAX_BYTES) {
        payload = JSON.stringify({ type: "snapshot", snapshot: this.snapshot(40) });
      }
      connection.send(payload);
    } catch (err) {
      console.warn(`snapshot send failed: ${errMsg(err)}`);
    }
  }

  private emit(
    agent: AgentName,
    kind: AgentEvent["kind"],
    text: string,
    bizId?: string,
    data?: Record<string, unknown>,
  ): AgentEvent {
    const ts = Date.now();
    const body: Omit<AgentEvent, "id"> = { ts, agent, kind, text };
    if (bizId) body.bizId = bizId;
    if (data) body.data = data;
    let id = 0;
    try {
      this.ensureSchema();
      const rows = this.sql<{ id: number }>`INSERT INTO co_events (ts, biz_id, json)
        VALUES (${ts}, ${bizId ?? null}, ${JSON.stringify(body)}) RETURNING id`;
      id = Number(rows[0]?.id ?? 0);
      if (++this.eventsSinceTrim >= 100) {
        this.eventsSinceTrim = 0;
        this.sql`DELETE FROM co_events WHERE id <= (SELECT MAX(id) FROM co_events) - ${EVENTS_KEPT}`;
      }
    } catch (err) {
      console.error(`event insert failed: ${errMsg(err)}`);
    }
    const event: AgentEvent = { id, ...body };
    this.send({ type: "event", event });
    return event;
  }

  private recentEvents(limit = SNAPSHOT_EVENTS): AgentEvent[] {
    const rows = this.sql<{ id: number; json: string }>`SELECT id, json FROM co_events ORDER BY id DESC LIMIT ${limit}`;
    const out: AgentEvent[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        out.push({ ...(JSON.parse(rows[i].json) as Omit<AgentEvent, "id">), id: Number(rows[i].id) });
      } catch {
        /* skip corrupt row */
      }
    }
    return out;
  }

  private eventsAfter(after: number, limit: number): AgentEvent[] {
    const rows = this.sql<{ id: number; json: string }>`SELECT id, json FROM co_events WHERE id > ${after} ORDER BY id ASC LIMIT ${limit}`;
    const out: AgentEvent[] = [];
    for (const r of rows) {
      try {
        out.push({ ...(JSON.parse(r.json) as Omit<AgentEvent, "id">), id: Number(r.id) });
      } catch {
        /* skip */
      }
    }
    return out;
  }

  // ── derived views ──

  private liveBusinesses(): Business[] {
    return [...this.businesses().values()].filter((b) => b.status !== "removed");
  }

  private shippedScore(b: Business): number | null {
    if (!b.scores.length) return null;
    const v = b.site?.version;
    const hit = v != null ? b.scores.find((s) => s.version === v) : undefined;
    return (hit ?? b.scores[b.scores.length - 1]).score;
  }

  private computeStats(): Stats {
    const all = [...this.businesses().values()];
    const live = all.filter((b) => b.status !== "removed");
    const built = live.filter((b) => BUILT.has(b.status));
    const buildTimes = all.map((b) => b.timings?.total).filter((t): t is number => typeof t === "number" && t > 0);
    return {
      scouted: live.length,
      built: built.length,
      tastePassed: built.filter((b) => (this.shippedScore(b) ?? 0) >= TASTE_BAR).length,
      contacted: live.filter((b) => b.contactedAt != null).length,
      replied: live.filter((b) => b.repliedAt != null).length,
      paid: all.filter((b) => b.paidAt != null).length,
      revenueCents: all.reduce((sum, b) => sum + (b.paidAt != null ? b.amountCents ?? 0 : 0), 0),
      spendCents: round4(all.reduce((sum, b) => sum + (Number.isFinite(b.costCents) ? b.costCents : 0), 0)),
      avgBuildMs: buildTimes.length ? Math.round(buildTimes.reduce((a, b) => a + b, 0) / buildTimes.length) : null,
      bestBuildMs: buildTimes.length ? Math.min(...buildTimes) : null,
    };
  }

  private snapshot(eventLimit = SNAPSHOT_EVENTS): Snapshot {
    return {
      businesses: this.liveBusinesses().sort((a, b) => a.createdAt - b.createdAt),
      events: this.recentEvents(eventLimit),
      stats: this.computeStats(),
    };
  }

  private publicUrl(): string {
    return (this.env.PUBLIC_URL || "https://coldopen.vnarasingamoorthy.workers.dev").replace(/\/+$/, "");
  }

  private hqCoords(): { lat: number; lon: number } {
    const lat = Number(this.env.HQ_LAT);
    const lon = Number(this.env.HQ_LON);
    return { lat: Number.isFinite(lat) ? lat : 37.7786, lon: Number.isFinite(lon) ? lon : -122.3893 };
  }

  private llmLabel(): string {
    let raw = "";
    try {
      raw = llmProviderLabel(this.env);
    } catch {
      raw = isAnthropicKey(this.env.ANTHROPIC_API_KEY) ? this.env.CLAUDE_MODEL || "claude" : "workers-ai";
    }
    return prettyModel(raw);
  }

  private integrations(): Record<string, boolean> {
    const safe = (fn: () => boolean) => {
      try {
        return !!fn();
      } catch {
        return false;
      }
    };
    return {
      claude: isAnthropicKey(this.env.ANTHROPIC_API_KEY),
      openai: safe(() => openaiEnabled(this.env)),
      workersAI: !!this.env.AI && safe(() => !workersAiStatus().quotaExhausted),
      workersAIQuotaExhausted: safe(() => workersAiStatus().quotaExhausted),
      stripeApi: stripeApiEnabled(this.env),
      stripeWebhook: stripeWebhookEnabled(this.env),
      slack: slackEnabled(this.env),
      higgsfield: safe(() => higgsfieldEnabled(this.env)),
      taste: safe(() => tasteEnabled(this.env)),
      brainbase: safe(() => brainbaseEnabled(this.env)),
    };
  }

  private integrationLine(): string {
    const i = this.integrations();
    const on: string[] = [];
    if (i.stripeApi) on.push(`Stripe API (${stripeMode(this.env) ?? "key"})`);
    else on.push("Stripe Payment Link");
    if (i.stripeWebhook) on.push("Stripe webhooks");
    if (i.slack) on.push("Slack");
    if (i.higgsfield) on.push("Higgsfield video");
    if (i.taste) on.push("Taste Labs");
    return `Brain: ${this.llmLabel()}. Wired: ${on.join(", ")}.`;
  }

  private distanceFromHq(b: { lat: number | null; lon: number | null }): number | null {
    if (b.lat == null || b.lon == null) return null;
    const hq = this.hqCoords();
    return Math.round(distanceMeters(hq.lat, hq.lon, b.lat, b.lon));
  }

  private uniqueId(name: string): string {
    const base = slugify(name);
    const taken = this.businesses();
    const reserved = new Set(["sub", "new", "api", "claim", "remove", "img", "agents"]);
    let id = base;
    let n = 2;
    while (taken.has(id) || reserved.has(id)) id = `${base}-${n++}`;
    return id;
  }

  private newBusiness(fields: {
    name: string;
    category: string;
    lat: number | null;
    lon: number | null;
    address: string | null;
    website: string | null;
    phone: string | null;
    email: string | null;
    openingHours: string | null;
    osmId: string | null;
    osmTags: Record<string, string>;
    scoutMs: number | null;
  }): Business {
    const now = Date.now();
    return {
      id: this.uniqueId(fields.name),
      name: fields.name,
      category: fields.category || "local business",
      lat: fields.lat,
      lon: fields.lon,
      address: fields.address,
      website: fields.website,
      phone: fields.phone,
      email: fields.email,
      openingHours: fields.openingHours,
      osmId: fields.osmId,
      osmTags: fields.osmTags ?? {},
      status: "scouted",
      brand: null,
      site: null,
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
      timings: fields.scoutMs != null ? { scout: Math.max(0, Math.round(fields.scoutMs)) } : {},
      costCents: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private fromPlace(p: ScoutedPlace, scoutMs: number | null, override?: { website?: string | null; category?: string | null }): Business {
    return this.newBusiness({
      name: clip(p.name, 120) || "Unnamed business",
      category: override?.category || p.category || "local business",
      lat: Number.isFinite(p.lat) ? p.lat : null,
      lon: Number.isFinite(p.lon) ? p.lon : null,
      address: p.address ?? null,
      website: override?.website || normalizeUrl(p.website) || null,
      phone: p.phone ?? null,
      email: p.email ?? null,
      openingHours: p.openingHours ?? null,
      osmId: p.osmId ? String(p.osmId) : null,
      osmTags: p.osmTags ?? {},
      scoutMs,
    });
  }

  /** Run work after the response, keeping the DO alive (alarm heartbeat) until it settles. */
  private background(label: string, fn: () => Promise<unknown>): void {
    const task = (async () => {
      let dispose: (() => void) | null = null;
      try {
        dispose = await this.keepAlive();
      } catch (err) {
        console.warn(`keepAlive unavailable for ${label}: ${errMsg(err)}`);
      }
      try {
        await fn();
      } catch (err) {
        console.error(`background task ${label} failed: ${errMsg(err)}`);
      } finally {
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      }
    })();
    this.ctx.waitUntil(task);
  }

  // ─── HTTP API ──────────────────────────────────────────────────────────────

  async onRequest(request: Request): Promise<Response> {
    try {
      this.ensureSchema();
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      return await this.route(request, url, path, request.method.toUpperCase());
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(`HQ request failed: ${errMsg(err)}`);
      return json({ error: `Something broke on our side: ${errMsg(err)}` }, 500);
    }
  }

  private async route(request: Request, url: URL, path: string, method: string): Promise<Response> {
    // Internal routes: only reachable from our own Worker (which strips this header from the public).
    if (path.startsWith("/api/_internal/")) {
      if (request.headers.get(INTERNAL_HEADER) !== "1") return json({ error: "Not found" }, 404);
      return this.routeInternal(request, url, path, method);
    }

    switch (path) {
      case "/api/state":
        if (method !== "GET") break;
        return json(this.snapshot());
      case "/api/config":
        if (method !== "GET") break;
        return json(this.config());
      case "/api/health":
        return json({ ok: true, businesses: this.liveBusinesses().length, running: this.running.size });
      case "/api/events": {
        if (method !== "GET") break;
        const after = clampInt(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER, 0);
        const limit = clampInt(url.searchParams.get("limit"), 1, 500, 200);
        return json({ events: after ? this.eventsAfter(after, limit) : this.recentEvents(limit) });
      }
      case "/api/businesses":
        if (method === "GET") return json({ businesses: this.snapshot().businesses });
        if (method === "POST") return this.createBusiness(await readJson(request));
        break;
      case "/api/scout":
        if (method !== "POST") break;
        return this.scoutBlock(await readJson(request));
      case "/api/run-block":
        if (method !== "POST") break;
        return this.runBlockRoute(await readJson(request));
      case "/api/reset":
        if (method !== "POST") break;
        return this.reset(await readJson(request));
      case "/api/stripe/webhook":
        if (method !== "POST") break;
        return this.stripeWebhook(request);
      default: {
        const m = path.match(/^\/api\/businesses\/([a-z0-9-]{1,80})(?:\/([a-z-]{1,20}))?$/);
        if (!m) return json({ error: `No route for ${method} ${path}` }, 404);
        const [, id, action] = m;
        return this.routeBusiness(request, id, action ?? "", method);
      }
    }
    return json({ error: `Method ${method} not allowed on ${path}` }, 405);
  }

  private async routeBusiness(request: Request, id: string, action: string, method: string): Promise<Response> {
    const biz = this.get(id);
    if (!biz) return json({ error: `No business with id "${id}".` }, 404);

    if (!action) {
      if (method === "GET") {
        if (biz.status === "removed") return json({ error: "This preview was removed at the owner's request.", id, name: biz.name }, 410);
        return json(biz);
      }
      if (method === "DELETE") return json(this.removeBusiness(id, "operator"));
      return json({ error: `Method ${method} not allowed` }, 405);
    }

    if (method !== "POST") return json({ error: `Method ${method} not allowed` }, 405);
    if (biz.status === "removed") return json({ error: "This preview was removed at the owner's request." }, 410);

    switch (action) {
      case "build":
      case "rebuild":
        return this.buildRoute(id);
      case "pitch":
        return this.regeneratePitch(id);
      case "status":
        return this.setStatus(id, await readJson(request));
      case "video":
        return this.videoRoute(id);
      case "video-url":
        return this.attachVideoUrl(id, await readJson(request));
      default:
        return json({ error: `Unknown action "${action}".` }, 404);
    }
  }

  private async routeInternal(request: Request, url: URL, path: string, method: string): Promise<Response> {
    let m = path.match(/^\/api\/_internal\/site\/([a-z0-9-]{1,80})$/);
    if (m && method === "GET") {
      const biz = this.get(m[1]);
      if (!biz) return json({ error: "Not found" }, 404);
      if (url.searchParams.get("view") === "1") this.noteView(biz, request.headers.get("x-co-ua") ?? "");
      return json({ business: biz });
    }
    m = path.match(/^\/api\/_internal\/claim\/([a-z0-9-]{1,80})$/);
    if (m && method === "POST") {
      const biz = this.get(m[1]);
      if (!biz) return json({ error: "Not found" }, 404);
      if (biz.status === "removed") return json({ business: biz, paymentUrl: null });
      const paymentUrl = biz.paymentUrl ?? (this.env.PAYMENT_LINK ? withClientReference(this.env.PAYMENT_LINK, biz.id) : null);
      if (paymentUrl && !BOT_UA.test(request.headers.get("x-co-ua") ?? "")) {
        const last = this.lastClaimEvent.get(biz.id) ?? 0;
        if (Date.now() - last > CLAIM_EVENT_THROTTLE_MS) {
          this.lastClaimEvent.set(biz.id, Date.now());
          this.emit("Closer", "info", `Someone hit "Claim it" on ${biz.name}'s preview — Stripe checkout is open for the $49 Launch Pack.`, biz.id, {
            stage: "checkout",
          });
        }
      }
      return json({ business: biz, paymentUrl });
    }
    m = path.match(/^\/api\/_internal\/remove\/([a-z0-9-]{1,80})$/);
    if (m && method === "POST") {
      const biz = this.get(m[1]);
      if (!biz) return json({ error: "Not found" }, 404);
      this.removeBusiness(biz.id, "owner");
      return json({ ok: true, name: biz.name });
    }
    m = path.match(/^\/api\/_internal\/pipeline\/([a-z0-9-]{1,80})$/);
    if (m && method === "POST") {
      await this.runPipeline(m[1]); // held open for the whole run: this request is the build's context
      const b = this.get(m[1]);
      return json({ ok: true, status: b?.status ?? null });
    }
    if (path === "/api/_internal/claimed" && method === "POST") {
      return this.handleClaimed(await readJson(request));
    }
    return json({ error: "Not found" }, 404);
  }

  private config(): Record<string, unknown> {
    const hq = this.hqCoords();
    return {
      publicUrl: this.publicUrl(),
      paymentLink: this.env.PAYMENT_LINK,
      hq: { lat: hq.lat, lon: hq.lon, label: HQ_LABEL },
      integrations: this.integrations(),
      llm: this.llmLabel(),
      stripeMode: stripeMode(this.env),
      tasteBar: TASTE_BAR,
      maxVersions: MAX_VERSIONS,
      priceCents: LAUNCH_PACK_CENTS,
    };
  }

  // ─── Scout ─────────────────────────────────────────────────────────────────

  private async scoutBlock(body: Record<string, unknown>): Promise<Response> {
    const radius = clampInt(body.radius, 100, 2000, 450);
    const limit = clampInt(body.limit, 1, 60, 24);
    if (this.scouting) throw new HttpError(409, "Scout is already sweeping the block — give it a few seconds.");
    this.scouting = true;
    const epoch = this.epoch;
    const hq = this.hqCoords();
    this.emit("Scout", "info", `Sweeping ${radius} m around 101 Townsend St on OpenStreetMap for independent shops, cafés and restaurants…`, undefined, {
      stage: "scout",
      phase: "start",
      radius,
    });
    const t0 = Date.now();
    try {
      const all = [...this.businesses().values()];
      const knownOsm = new Set(all.map((b) => b.osmId).filter((x): x is string => !!x));
      const want = Math.min(200, limit + knownOsm.size);
      const places = await withTimeout(scoutNearby(hq.lat, hq.lon, radius, want), SCOUT_TIMEOUT_MS, "Overpass sweep");
      const ms = Date.now() - t0;
      if (epoch !== this.epoch) throw new HttpError(409, "The board was reset mid-sweep — scout again.");

      const seen = new Set<string>();
      const fresh: ScoutedPlace[] = [];
      for (const p of places) {
        const key = p.osmId ? String(p.osmId) : `${p.name}|${p.lat}|${p.lon}`;
        if (!p.name || seen.has(key) || (p.osmId && knownOsm.has(String(p.osmId)))) continue;
        seen.add(key);
        fresh.push(p);
      }
      const added = fresh.slice(0, limit).map((p) => this.insert(this.fromPlace(p, ms)));
      if (added.length) this.send({ type: "stats", stats: this.computeStats() });

      const total = this.liveBusinesses().length;
      if (!added.length) {
        this.emit(
          "Scout",
          "info",
          places.length
            ? `Swept ${radius} m in ${fmtMs(ms)} — all ${plural(places.length, "independent")} in range are already on the board. Widen the radius to find more.`
            : `Swept ${radius} m in ${fmtMs(ms)} and OSM came back empty. Try a wider radius.`,
          undefined,
          { stage: "scout", phase: "done", ms, found: places.length, added: 0 },
        );
      } else {
        const byCat = new Map<string, number>();
        for (const b of added) byCat.set(b.category, (byCat.get(b.category) ?? 0) + 1);
        const breakdown = [...byCat.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([c, n]) => `${c} ×${n}`)
          .join(", ");
        const withSite = added.filter((b) => b.website).length;
        const nearest = added
          .map((b) => ({ b, d: this.distanceFromHq(b) }))
          .filter((x): x is { b: Business; d: number } => x.d != null)
          .sort((a, b) => a.d - b.d)[0];
        this.emit(
          "Scout",
          "success",
          `Swept ${radius} m in ${fmtMs(ms)}: ${plural(added.length, "new independent")} on the board (${breakdown}). ` +
            `${
              withSite === added.length
                ? `All ${added.length} list a website`
                : withSite === 0
                  ? "None list a website (Archivist will work from OSM tags)"
                  : `${withSite} list a website, ${added.length - withSite} don't`
            }${nearest ? ` · closest is ${nearest.b.name}, ${nearest.d} m from HQ` : ""}.`,
          undefined,
          { stage: "scout", phase: "done", ms, found: places.length, added: added.length, radius },
        );
        if (slackEnabled(this.env)) {
          this.ctx.waitUntil(
            notifySlack(this.env, `*Cold Open · Scout* swept ${radius} m around Cloudflare HQ: ${added.length} new independents (${breakdown}). ${total} on the board.`),
          );
        }
      }
      return json({ added, total });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const msg = errMsg(err);
      this.emit("Scout", "warn", `Overpass didn't come through (${msg}). OSM mirrors get busy — try again in a moment.`, undefined, {
        stage: "scout",
        phase: "error",
      });
      throw new HttpError(502, `Scouting failed: ${msg}`);
    } finally {
      this.scouting = false;
    }
  }

  private async createBusiness(body: Record<string, unknown>): Promise<Response> {
    const name = str(body.name, 120);
    if (!name) throw new HttpError(400, "Give me a business name.");
    const website = normalizeUrl(body.website);
    if (str(body.website, 500) && !website) throw new HttpError(400, "That website doesn't look like a URL — try something like redwoodcafe.com.");
    const category = str(body.category, 40)?.toLowerCase() ?? null;
    const address = str(body.address, 200);

    const existingByName = (n: string) => {
      const key = slugify(n).replace(/^the-/, "");
      return [...this.businesses().values()].find((b) => slugify(b.name).replace(/^the-/, "") === key) ?? null;
    };
    const reuse = (b: Business): Response => {
      if (b.status === "removed") {
        throw new HttpError(409, `${b.name} asked us to take their preview down, so we won't rebuild it.`);
      }
      let cur = b;
      if (website && !cur.website) cur = this.update(cur.id, { website }) ?? cur;
      this.emit("Scout", "info", `${cur.name} is already on the board — reusing it.`, cur.id, { stage: "scout", phase: "done", ms: 0 });
      return json(cur, 200);
    };

    const sameName = existingByName(name);
    if (sameName) return reuse(sameName);

    const hq = this.hqCoords();
    const t0 = Date.now();
    let place: ScoutedPlace | null = null;
    let lookupFailed = false;
    if (!address) {
      this.emit("Scout", "info", `Looking up "${name}" on OpenStreetMap within 1.5 km of HQ…`, undefined, { stage: "scout", phase: "start" });
      try {
        // With a website in hand the lookup is a nice-to-have (map pin, hours), so cap it tighter.
        place = await withTimeout(findByName(name, hq.lat, hq.lon), website ? 8_000 : NAME_LOOKUP_TIMEOUT_MS, "OSM name lookup");
      } catch (err) {
        lookupFailed = true;
        this.emit("Scout", "warn", `OSM lookup for "${name}" didn't answer (${errMsg(err)}).`, undefined, {
          stage: "scout",
          phase: "error",
        });
      }
    }
    const ms = Date.now() - t0;

    if (place?.osmId) {
      const byOsm = [...this.businesses().values()].find((b) => b.osmId === String(place!.osmId));
      if (byOsm) return reuse(byOsm);
    }
    if (place) {
      const sameCanon = existingByName(place.name);
      if (sameCanon) return reuse(sameCanon);
    }

    let biz: Business;
    if (place) {
      biz = this.fromPlace(place, ms, { website, category });
      const d = this.distanceFromHq(biz);
      this.insert(biz);
      this.emit(
        "Scout",
        "success",
        `Found ${biz.name} on OSM in ${fmtMs(ms)} — ${biz.category}${d != null ? `, ${d} m from HQ` : ""}${biz.address ? `, ${biz.address}` : ""}` +
          `${biz.website ? ` · site: ${hostOf(biz.website)}` : " · no website on file"}${biz.openingHours ? " · hours listed" : ""}.`,
        biz.id,
        { stage: "scout", phase: "done", ms },
      );
    } else {
      biz = this.newBusiness({
        name,
        category: category ?? "local business",
        lat: null,
        lon: null,
        address,
        website,
        phone: null,
        email: null,
        openingHours: null,
        osmId: null,
        osmTags: {},
        scoutMs: ms,
      });
      this.insert(biz);
      this.emit(
        "Scout",
        "info",
        `${address ? `Added ${name} at ${address}` : lookupFailed ? `Added ${name}` : `No OSM match for "${name}" within 1.5 km`} — working from ${website ? hostOf(website) : "the name and category alone"}.`,
        biz.id,
        { stage: "scout", phase: "done", ms },
      );
    }
    this.send({ type: "stats", stats: this.computeStats() });
    return json(biz, 201);
  }

  // ─── Build orchestration ───────────────────────────────────────────────────

  private buildRoute(id: string): Response {
    if (this.running.has(id)) return json({ ok: true, alreadyRunning: true }, 202);
    this.queued.delete(id);
    this.background(`build:${id}`, () => this.runPipeline(id));
    return json({ ok: true }, 202);
  }

  private runBlockRoute(body: Record<string, unknown>): Response {
    const limit = clampInt(body.limit, 1, 60, 8);
    const candidates = this.liveBusinesses()
      .filter((b) => b.status === "scouted" && !this.running.has(b.id) && !this.queued.has(b.id))
      .sort((a, b) => (this.distanceFromHq(a) ?? 1e9) - (this.distanceFromHq(b) ?? 1e9) || a.createdAt - b.createdAt);
    const ids = candidates.slice(0, limit).map((b) => b.id);
    if (!ids.length) {
      const inFlight = this.running.size + this.queued.size;
      throw new HttpError(
        400,
        inFlight
          ? `Everything scouted is already building (${inFlight} in flight).`
          : "Nothing waiting to build — scout the block first.",
      );
    }
    for (const id of ids) {
      this.queued.add(id);
      this.blockMembers.add(id);
    }
    const names = ids.slice(0, 3).map((id) => this.get(id)?.name ?? id);
    this.emit(
      "System",
      "info",
      `Running the block: ${plural(ids.length, "build")}, ${Math.min(BLOCK_CONCURRENCY, ids.length)} at a time, nearest first — ${names.join(", ")}${ids.length > 3 ? ` +${ids.length - 3} more` : ""}.`,
      undefined,
      { stage: "block", phase: "start", count: ids.length },
    );
    const epoch = this.epoch;
    this.background("run-block", () => this.runBlock(ids, epoch));
    return json({ ok: true, queued: ids.length, ids }, 202);
  }

  private async runBlock(ids: string[], epoch: number): Promise<void> {
    const t0 = Date.now();
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length && epoch === this.epoch) {
        const id = ids[cursor++];
        this.queued.delete(id);
        const b = this.get(id);
        if (!b || b.status !== "scouted") continue; // built/removed by hand while queued
        await this.runIsolated(id);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(BLOCK_CONCURRENCY, ids.length) }, () => worker()));
    } finally {
      for (const id of ids) {
        this.queued.delete(id);
        this.blockMembers.delete(id);
      }
    }
    if (epoch !== this.epoch) return;

    const done = ids.map((id) => this.get(id)).filter((b): b is Business => !!b && b.status !== "removed");
    const live = done.filter((b) => BUILT.has(b.status));
    const failed = done.filter((b) => b.status === "error");
    const passed = live.filter((b) => (this.shippedScore(b) ?? 0) >= TASTE_BAR);
    const ms = Date.now() - t0;
    const stats = this.computeStats();
    const blockSpend = round4(done.reduce((s, b) => s + (Number.isFinite(b.costCents) ? b.costCents : 0), 0));
    this.emit(
      "System",
      live.length ? "success" : "warn",
      `Block done in ${fmtMs(ms)}: ${live.length}/${ids.length} sites live, ${passed.length} cleared the ${TASTE_BAR} taste bar` +
        `${failed.length ? `, ${failed.length} ${failed.length === 1 ? "needs" : "need"} a rebuild` : ""}.`,
      undefined,
      { stage: "block", phase: "done", ms, live: live.length, failed: failed.length, passed: passed.length },
    );
    this.emit(
      "CFO",
      "info",
      `This block cost ${fmtSpend(blockSpend)} in model spend${live.length ? ` (${fmtSpend(blockSpend / Math.max(1, live.length))} per live site)` : ""}. ` +
        `Board total: ${fmtSpend(stats.spendCents)} spent vs ${fmtMoney(stats.revenueCents)} revenue.`,
      undefined,
      { spendCents: stats.spendCents, revenueCents: stats.revenueCents, blockSpendCents: blockSpend },
    );
    if (slackEnabled(this.env) && live.length) {
      const pub = this.publicUrl();
      const lines = live
        .slice(0, 10)
        .map((b) => `• ${slackLink(`${pub}/s/${b.id}`, b.name)} — ${this.shippedScore(b) ?? "?"}/100`)
        .join("\n");
      await notifySlack(
        this.env,
        `*Cold Open · Block done* — ${live.length}/${ids.length} sites live in ${fmtMs(ms)}, ${passed.length} passed the taste gate.\n${lines}`,
      );
    }
  }

  /**
   * Run one pipeline as its own request to this same Durable Object, so every build gets a fresh
   * per-invocation subrequest budget (a block of 8 builds in one context would exceed the free
   * plan's 50). Falls back to running in the current context if self-dispatch is unavailable.
   */
  private async runIsolated(id: string): Promise<void> {
    try {
      const self = (this.env.HQ as DurableObjectNamespace).get(this.ctx.id);
      const res = await self.fetch(
        new Request(`https://hq.internal/api/_internal/pipeline/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { [INTERNAL_HEADER]: "1" },
        }),
      );
      await res.text().catch(() => "");
      if (res.ok) return;
      console.warn(`isolated pipeline dispatch for ${id} returned ${res.status}; running inline`);
    } catch (err) {
      console.warn(`isolated pipeline dispatch for ${id} failed (${errMsg(err)}); running inline`);
    }
    await this.runPipeline(id); // no-op if the dispatched run is still going
  }

  /** The whole pipeline for one business. Never throws. */
  async runPipeline(id: string): Promise<void> {
    if (this.running.has(id)) return;
    const epoch = this.epoch;
    const start = this.get(id);
    if (!start || start.status === "removed") return;
    const token = ++this.runSeq;
    this.running.set(id, token);

    const check = (): Business => {
      const b = this.get(id);
      if (epoch !== this.epoch || this.running.get(id) !== token || !b || b.status === "removed") throw new PipelineAbort();
      return b;
    };
    const addCost = (cents: number) => (b: Business) => round4(b.costCents + (Number.isFinite(cents) ? Math.max(0, cents) : 0));
    // Stages may report spend by return value, by writing the llm.ts ledger, or both (same amount).
    // Taking the max of the two never double-counts and never drops ledger-only spend.
    const stageCost = (returned: number | undefined): number => {
      let drained = 0;
      try {
        drained = takeCost(id);
      } catch {
        drained = 0;
      }
      const r = typeof returned === "number" && Number.isFinite(returned) ? Math.max(0, returned) : 0;
      return round4(Math.max(r, drained));
    };
    try {
      takeCost(id); // discard anything a previous, interrupted run left behind
    } catch {
      /* ledger unavailable */
    }

    const t0 = Date.now();
    let stage: Stage = "archivist";
    let spent = 0;
    const isRebuild = !!start.site;

    try {
      const timings: Business["timings"] = start.timings?.scout != null ? { scout: start.timings.scout } : {};
      let biz = this.update(id, { status: "extracting", error: null, scores: [], timings })!;
      this.emit("System", "info", `${isRebuild ? "Rebuilding" : "Building"} ${biz.name} — ${this.llmLabel()} is on it.`, id, {
        stage: "pipeline",
        phase: "start",
      });

      // 1 ── Archivist: brand extraction
      stage = "archivist";
      const tA = Date.now();
      const tagHints = ["cuisine", "amenity", "shop", "craft", "leisure", "diet:vegan", "diet:vegetarian"]
        .filter((k) => biz.osmTags?.[k])
        .slice(0, 3)
        .map((k) => `${k}=${biz.osmTags[k]}`);
      this.emit(
        "Archivist",
        "info",
        biz.website
          ? `Reading ${hostOf(biz.website)} — title, meta, og:image, theme-color, palette frequency, headings, visible copy.`
          : `No website on file, so I'm reading OSM tags${tagHints.length ? ` (${tagHints.join(", ")})` : ""} and the name itself. Nothing gets invented.`,
        id,
        { stage, phase: "start" },
      );
      const brandRes = await withTimeout(extractBrand(this.env, biz), STAGE_TIMEOUT_MS.archivist, "Archivist");
      check();
      const brandResCost = stageCost(brandRes.costCents);
      spent += brandResCost;
      const brand: Brand = brandRes.brand;
      const aMs = Date.now() - tA;
      biz = this.update(id, (b) => ({
        brand,
        costCents: addCost(brandResCost)(b),
        timings: { ...b.timings, archivist: aMs },
      }))!;
      this.emit("Archivist", "success", this.brandLine(brand, brandRes.signals, aMs), id, {
        stage,
        phase: "done",
        ms: aMs,
        provider: brandRes.provider,
        signals: brandRes.signals,
      });

      // 2+3 ── Builder ⇄ Critic taste loop
      let prev: SiteSpec | null = null;
      let feedback: string[] = [];
      let best: { spec: SiteSpec; score: ScoreVersion } | null = null;
      let prevScore: number | null = null;
      let builderMs = 0;
      let criticMs = 0;

      for (let v = 1; v <= MAX_VERSIONS; v++) {
        stage = "builder";
        biz = this.update(id, { status: "building" })!;
        this.emit(
          "Builder",
          "info",
          v === 1
            ? `Composing v1${brand.vibe ? ` for a "${clip(brand.vibe, 60)}" feel` : ""} in ${brand.fonts?.heading ?? "their"} type.`
            : `Revising into v${v} against ${plural(feedback.length, "critic note")}.`,
          id,
          { stage, phase: "start", version: v },
        );
        const tB = Date.now();
        const built = await withTimeout(composeSite(this.env, biz, brand, prev, feedback), STAGE_TIMEOUT_MS.builder, "Builder");
        check();
        const builtCost = stageCost(built.costCents);
        spent += builtCost;
        const spec: SiteSpec = { ...built.spec, version: v };
        const bMs = Date.now() - tB;
        builderMs += bMs;
        biz = this.update(id, (b) => ({
          site: spec,
          costCents: addCost(builtCost)(b),
          timings: { ...b.timings, builder: builderMs },
        }))!;
        this.emit(
          "Builder",
          "success",
          `v${v} drafted in ${fmtMs(bMs)} — ${spec.theme} theme, headline "${clip(spec.headline, 90)}", CTA "${clip(spec.ctaLabel, 40)}".`,
          id,
          { stage, phase: "done", version: v, ms: bMs },
        );

        stage = "critic";
        biz = this.update(id, { status: "critiquing" })!;
        const tC = Date.now();
        const crit = await withTimeout(critique(this.env, biz, brand, spec), STAGE_TIMEOUT_MS.critic, "Critic");
        check();
        const critCost = stageCost(crit.costCents);
        spent += critCost;
        const cMs = Date.now() - tC;
        criticMs += cMs;
        const raw = crit.version;
        const sv: ScoreVersion = {
          version: v,
          score: Math.max(0, Math.min(100, Math.round(Number(raw?.score) || 0))),
          notes: Array.isArray(raw?.notes) ? raw.notes.filter((n) => typeof n === "string" && n.trim()).slice(0, 8) : [],
          slopHits: Array.isArray(raw?.slopHits) ? raw.slopHits.filter((n) => typeof n === "string" && n.trim()).slice(0, 12) : [],
          provider: raw?.provider || this.llmLabel(),
          at: raw?.at || Date.now(),
        };
        biz = this.update(id, (b) => ({
          scores: [...b.scores, sv],
          costCents: addCost(critCost)(b),
          timings: { ...b.timings, critic: criticMs },
        }))!;
        const passed = sv.score >= TASTE_BAR;
        if (!best || sv.score > best.score.score) best = { spec, score: sv };
        this.emit("Critic", passed ? "success" : "warn", this.criticLine(sv, passed, prevScore), id, {
          stage,
          phase: "done",
          version: v,
          score: sv.score,
          passed,
          ms: cMs,
          provider: sv.provider,
          slopHits: sv.slopHits,
        });
        if (passed) break;
        prevScore = sv.score;
        prev = spec;
        feedback = [
          ...sv.notes,
          ...sv.slopHits.map((h) => `Remove the banned/generic phrase "${h}" and say something specific to ${biz.name} instead.`),
        ];
        if (!feedback.length) feedback = [`Score was ${sv.score}/100. Make the headline and copy more specific to ${biz.name}.`];
      }

      if (best) {
        if (biz.site?.version !== best.spec.version) {
          biz = this.update(id, { site: best.spec })!;
          this.emit(
            "Critic",
            "info",
            `Shipping v${best.spec.version} (${best.score.score}) — the later draft scored lower, so it doesn't make the cut.`,
            id,
            { stage: "critic", phase: "select", version: best.spec.version, score: best.score.score },
          );
        }
        if (best.score.score < TASTE_BAR) {
          this.emit(
            "Critic",
            "warn",
            `Best effort is v${best.spec.version} at ${best.score.score}, under the ${TASTE_BAR} bar after ${MAX_VERSIONS} passes. Shipping it flagged; Rebuild takes another swing.`,
            id,
            { stage: "critic", phase: "flagged", score: best.score.score },
          );
        }
      }

      // 4 ── Director: hero frame (+ optional Higgsfield clip)
      stage = "director";
      biz = this.update(id, { status: "directing" })!;
      this.emit("Director", "info", `Directing the hero frame${brand.vibe ? `: ${clip(brand.vibe, 80)}` : ""}.`, id, { stage, phase: "start" });
      const tD = Date.now();
      try {
        const hero = await withTimeout(makeHero(this.env, biz, brand, biz.site!), STAGE_TIMEOUT_MS.director, "Director");
        check();
        const heroCost = stageCost(hero.costCents);
        spent += heroCost;
        const dMs = Date.now() - tD;
        const oldHero = biz.heroImage;
        if (oldHero && oldHero !== hero.heroImage && oldHero.startsWith("/img/")) {
          // The superseded frame is no longer referenced anywhere; drop it from KV.
          let oldKey: string | null = null;
          try {
            oldKey = decodeURIComponent(oldHero.slice(5));
          } catch {
            oldKey = null;
          }
          if (oldKey && oldKey.startsWith(`img:${id}:`)) {
            this.ctx.waitUntil(this.env.MEDIA.delete(oldKey).catch(() => undefined));
          }
        }
        biz = this.update(id, (b) => ({
          heroImage: hero.heroImage,
          costCents: addCost(heroCost)(b),
          timings: { ...b.timings, director: dMs },
        }))!;
        this.emit("Director", "success", `Hero frame rendered with ${hero.model} in ${fmtMs(dMs)}.`, id, {
          stage,
          phase: "done",
          ms: dMs,
          model: hero.model,
          heroImage: hero.heroImage,
        });
        let videoOn = false;
        try {
          videoOn = higgsfieldEnabled(this.env);
        } catch {
          videoOn = false;
        }
        // Auto-render the clip for single builds (live challenge / manual Build). Block runs skip it so a
        // 24-business sweep doesn't burn Higgsfield credits; the per-card video button starts one on demand.
        if (videoOn && hero.heroImage && !this.blockMembers.has(id)) this.background(`video:${id}`, () => this.startVideoFor(id));
      } catch (err) {
        if (err instanceof PipelineAbort) throw err;
        check();
        const dMs = Date.now() - tD;
        const failedCost = stageCost((err as { costCents?: number })?.costCents);
        spent += failedCost;
        biz = this.update(id, (b) => ({ costCents: addCost(failedCost)(b), timings: { ...b.timings, director: dMs } }))!;
        this.emit(
          "Director",
          "warn",
          `Hero render failed (${errMsg(err)}). ${biz.heroImage ? "Keeping the previous frame." : "The site ships with a typographic hero instead."}`,
          id,
          { stage, phase: "error", ms: dMs },
        );
      }

      // 5 ── Closer: checkout link + honest pitch
      stage = "closer";
      const tK = Date.now();
      this.emit("Closer", "info", "Wiring checkout and writing the pitch — no invented reviews, no fake urgency.", id, { stage, phase: "start" });
      const pay = await this.ensurePaymentUrl(biz);
      biz = check();
      if (pay.url && pay.url !== biz.paymentUrl) biz = this.update(id, { paymentUrl: pay.url })!;
      const pub = this.publicUrl();
      const links = { previewUrl: `${pub}/s/${id}`, paymentUrl: `${pub}/s/${id}/claim` };
      const pitchRes = await withTimeout(writePitch(this.env, biz, brand, biz.site!, links), STAGE_TIMEOUT_MS.closer, "Closer");
      check();
      const pitchResCost = stageCost(pitchRes.costCents);
      spent += pitchResCost;
      const kMs = Date.now() - tK;
      biz = this.update(id, (b) => ({
        pitch: pitchRes.pitch,
        costCents: addCost(pitchResCost)(b),
        timings: { ...b.timings, closer: kMs },
      }))!;
      this.emit(
        "Closer",
        "success",
        `Pitch ready in ${fmtMs(kMs)}: "${clip(pitchRes.pitch.subject, 90)}". Checkout is a ${pay.dedicated ? `dedicated Stripe Payment Link for ${biz.name}` : "Stripe Payment Link"} tagged client_reference_id=${id}.`,
        id,
        { stage, phase: "done", ms: kMs, dedicatedLink: pay.dedicated },
      );

      // 6 ── Ready
      const total = Date.now() - t0;
      const finalStatus: BizStatus = biz.paidAt ? "paid" : biz.repliedAt ? "replied" : biz.contactedAt ? "contacted" : "ready";
      biz = this.update(id, (b) => ({ status: finalStatus, error: null, timings: { ...b.timings, total } }))!;
      const score = this.shippedScore(biz);
      const versions = biz.scores.length;
      this.emit(
        "System",
        "success",
        `${biz.name} is live at /s/${id} — ${fmtMs(total)} end to end, ${versions > 1 ? `${versions} drafts, ` : ""}shipped v${biz.site?.version ?? 1} at ${score ?? "?"}/100.`,
        id,
        { stage: "pipeline", phase: "done", ms: total, score, url: `${pub}/s/${id}`, versions },
      );
      this.cfoAfterBuild(biz, spent);
      if (brainbaseEnabled(this.env)) this.background(`brainbase:${id}`, () => this.brainbaseSecondOpinion(id));
      if (!this.blockMembers.has(id) && slackEnabled(this.env)) {
        this.ctx.waitUntil(
          notifySlack(
            this.env,
            `*Cold Open · Live* ${slackLink(`${pub}/s/${id}`, biz.name)} built in ${fmtMs(total)} — shipped v${biz.site?.version ?? 1} at ${score ?? "?"}/100, cost ${fmtSpend(spent)}.`,
          ),
        );
      }
    } catch (err) {
      if (err instanceof PipelineAbort) return;
      const msg = errMsg(err);
      const cur = this.get(id);
      if (cur && cur.status !== "removed" && epoch === this.epoch && this.running.get(id) === token) {
        const total = Date.now() - t0;
        const failedCost = stageCost((err as { costCents?: number })?.costCents);
        this.update(id, (b) => ({
          status: "error",
          error: `${STAGE_AGENT[stage]}: ${msg}`,
          costCents: addCost(failedCost)(b),
          timings: { ...b.timings, total: undefined },
        }));
        this.emit(STAGE_AGENT[stage], "error", `Hit a wall on ${cur.name}: ${msg}. Marked as error after ${fmtMs(total)} — hit Rebuild to retry.`, id, {
          stage,
          phase: "error",
        });
      }
    } finally {
      if (this.running.get(id) === token) this.running.delete(id);
    }
  }

  /** Independent review by a Brainbase Labs managed agent. Background only: never blocks or fails a build. */
  private async brainbaseSecondOpinion(id: string): Promise<void> {
    const epoch = this.epoch;
    const biz = this.get(id);
    if (!biz || biz.status === "removed") return;
    const previewUrl = `${this.publicUrl()}/s/${id}`;
    const b = biz.brand;
    const brandSummary = b
      ? clip([`${b.name}: ${b.tagline}`, b.vibe && `Vibe: ${b.vibe}`, b.voice && `Voice: ${b.voice}`].filter(Boolean).join(". "), 400)
      : clip(`${biz.name}, ${biz.category}`, 200);
    this.emit("Critic", "info", `Asking a Brainbase Labs agent (harness ${BRAINBASE_HARNESS}) for an independent second opinion on ${biz.name}…`, id, {
      provider: "brainbase",
    });
    const t0 = Date.now();
    const res = await reviewSite(this.env, { bizName: biz.name, previewUrl, brandSummary });
    const ms = Date.now() - t0;
    const cur = this.get(id);
    if (epoch !== this.epoch || !cur || cur.status === "removed") return;
    if (!res) {
      this.emit("Critic", "warn", `Brainbase second opinion unavailable for ${cur.name} after ${fmtMs(ms)}${lastBrainbaseError ? ` — ${lastBrainbaseError}` : ""}; the shipped score stands.`, id, {
        provider: "brainbase",
        ms,
      });
      return;
    }
    const kind: AgentEvent["kind"] = res.score != null && res.score >= TASTE_BAR ? "success" : "info";
    this.emit(
      "Critic",
      kind,
      `Brainbase second opinion (harness ${res.harness ?? BRAINBASE_HARNESS}): ${res.score ?? "unscored"} — ${clip(res.verdict, 320)}`,
      id,
      { provider: "brainbase", threadId: res.threadId, traceUrl: res.traceUrl, score: res.score, model: res.model, ms },
    );
  }

  private brandLine(brand: Brand, signals: string[], ms: number): string {
    const p = brand.palette ?? ({} as Brand["palette"]);
    const colors = [p.primary, p.secondary, p.accent].filter(Boolean).join(" / ");
    const fonts = brand.fonts ? `${brand.fonts.heading} + ${brand.fonts.body}` : "";
    const evidence = (signals?.length ? signals : brand.sourceSignals ?? []).slice(0, 4);
    const moreEvidence = (signals?.length ?? 0) > 4 ? ` +${signals.length - 4} more` : "";
    const offerings = brand.offeringsConfirmed
      ? `${plural(brand.offerings?.length ?? 0, "offering")} read off their own site.`
      : `Menu unknown, so offerings get labeled "owner to confirm".`;
    return (
      `Brand kit in ${fmtMs(ms)}: ${colors || "palette inferred"}${fonts ? `, ${fonts}` : ""}${brand.voice ? `, voice "${clip(brand.voice, 60)}"` : ""}. ` +
      `${evidence.length ? `Evidence: ${evidence.map((s) => clip(s, 48)).join(" · ")}${moreEvidence}. ` : ""}${offerings}`
    );
  }

  private criticLine(sv: ScoreVersion, passed: boolean, prevScore: number | null): string {
    const notes = sv.notes.map(stripPeriod).filter(Boolean);
    const slop = sv.slopHits.length ? ` Banned phrases: ${sv.slopHits.slice(0, 4).map((h) => `"${h}"`).join(", ")}.` : "";
    const delta = prevScore != null ? ` (${sv.score >= prevScore ? "up" : "down"} from ${prevScore})` : "";
    if (passed) {
      return `v${sv.version} scored ${sv.score}${delta} — clears the ${TASTE_BAR} bar${sv.version === 1 ? " on the first pass" : ""}.${notes[0] ? ` ${notes[0]}.` : ""}`;
    }
    const why = notes.slice(0, 2).join("; ");
    const tail = sv.version < MAX_VERSIONS ? " Sending it back to Builder." : " That was the last pass.";
    return `v${sv.version} scored ${sv.score}${delta}${why ? ` — ${why}.` : "."}${slop}${tail}`;
  }

  private cfoAfterBuild(biz: Business, spent: number): void {
    const stats = this.computeStats();
    let tail = ".";
    if (stats.revenueCents > 0 && stats.spendCents > 0) {
      tail = ` — ${Math.max(1, Math.round(stats.revenueCents / stats.spendCents)).toLocaleString("en-US")}× return on model spend.`;
    } else if (stats.built > 0 && stats.spendCents > 0) {
      const perSite = stats.spendCents / stats.built;
      if (perSite > 0) tail = `. One $49 claim covers ~${Math.floor(LAUNCH_PACK_CENTS / perSite).toLocaleString("en-US")} builds at this rate.`;
    }
    this.emit(
      "CFO",
      "info",
      `${biz.name} cost ${fmtSpend(spent)} to build. Board: ${fmtSpend(stats.spendCents)} spent vs ${fmtMoney(stats.revenueCents)} revenue${tail}`,
      biz.id,
      { costCents: round4(spent), spendCents: stats.spendCents, revenueCents: stats.revenueCents },
    );
  }

  private async ensurePaymentUrl(biz: Business): Promise<{ url: string | null; dedicated: boolean }> {
    const shared = this.env.PAYMENT_LINK || "";
    if (biz.paymentUrl && shared && !biz.paymentUrl.startsWith(shared)) return { url: biz.paymentUrl, dedicated: true };
    if (stripeApiEnabled(this.env)) {
      try {
        const link = await createBusinessPaymentLink(this.env, biz, this.publicUrl());
        if (link) return { url: link, dedicated: true };
      } catch (err) {
        console.warn(`per-business payment link failed: ${errMsg(err)}`);
      }
    }
    return { url: shared ? withClientReference(shared, biz.id) : null, dedicated: false };
  }

  // ─── Per-business actions ──────────────────────────────────────────────────

  private async regeneratePitch(id: string): Promise<Response> {
    let biz = this.get(id)!;
    if (!biz.brand || !biz.site) throw new HttpError(400, "Build the site first — the pitch quotes it.");
    if (this.running.has(id)) throw new HttpError(409, `${biz.name} is mid-build; the Closer will write a fresh pitch at the end.`);
    const epoch = this.epoch;
    this.emit("Closer", "info", `Rewriting the pitch for ${biz.name}…`, id, { stage: "closer", phase: "start" });
    const t0 = Date.now();
    try {
      const pay = biz.paymentUrl ? { url: biz.paymentUrl } : await this.ensurePaymentUrl(biz);
      const pub = this.publicUrl();
      const res = await withTimeout(
        writePitch(this.env, biz, biz.brand, biz.site, { previewUrl: `${pub}/s/${id}`, paymentUrl: `${pub}/s/${id}/claim` }),
        STAGE_TIMEOUT_MS.closer,
        "Closer",
      );
      const cur = this.get(id);
      if (!cur || cur.status === "removed" || epoch !== this.epoch) throw new HttpError(410, "This business was removed while the pitch was being written.");
      let drained = 0;
      try {
        drained = takeCost(id);
      } catch {
        drained = 0;
      }
      const cost = round4(Math.max(Number.isFinite(res.costCents) ? Math.max(0, res.costCents) : 0, drained));
      biz = this.update(id, (b) => ({
        pitch: res.pitch,
        paymentUrl: b.paymentUrl ?? pay.url,
        costCents: round4(b.costCents + cost),
      }))!;
      this.emit("Closer", "success", `Fresh pitch for ${biz.name} in ${fmtMs(Date.now() - t0)}: "${clip(res.pitch.subject, 90)}".`, id, {
        stage: "closer",
        phase: "done",
        ms: Date.now() - t0,
      });
      return json(biz);
    } catch (err) {
      try {
        const leaked = Math.max(takeCost(id), (err as { costCents?: number })?.costCents ?? 0);
        if (leaked > 0 && this.get(id)) this.update(id, (b) => ({ costCents: round4(b.costCents + leaked) }));
      } catch {
        /* ledger unavailable */
      }
      if (err instanceof HttpError) throw err;
      this.emit("Closer", "error", `Couldn't rewrite the pitch for ${biz.name}: ${errMsg(err)}.`, id, { stage: "closer", phase: "error" });
      throw new HttpError(502, `Pitch generation failed: ${errMsg(err)}`);
    }
  }

  private setStatus(id: string, body: Record<string, unknown>): Response {
    const target = body.status;
    const biz = this.get(id)!;
    if (target !== "contacted" && target !== "replied") {
      throw new HttpError(400, `status must be "contacted" or "replied".`);
    }
    if (!biz.site) throw new HttpError(400, `Build ${biz.name}'s site before marking outreach.`);
    const now = Date.now();
    const next = this.update(id, (b) => {
      const locked = b.status === "paid" || TRANSIENT.has(b.status) || b.status === "error";
      if (target === "contacted") {
        return {
          contactedAt: b.contactedAt ?? now,
          status: locked || b.status === "replied" ? b.status : "contacted",
        };
      }
      return {
        contactedAt: b.contactedAt ?? now,
        repliedAt: b.repliedAt ?? now,
        status: locked ? b.status : "replied",
      };
    })!;
    if (target === "contacted") {
      this.emit(
        "Closer",
        "info",
        `Marked ${biz.name} as contacted. Outreach is sent by a human${biz.email ? ` (${biz.email} is on file)` : ""} — Cold Open never auto-emails.`,
        id,
        { status: "contacted" },
      );
    } else {
      this.emit("Closer", "success", `${biz.name} replied. Warm lead — the preview did its job.`, id, { status: "replied" });
      if (slackEnabled(this.env)) {
        this.ctx.waitUntil(notifySlack(this.env, `*Cold Open · Reply* ${slackLink(`${this.publicUrl()}/s/${id}`, biz.name)} wrote back.`));
      }
    }
    return json(next);
  }

  private videoRoute(id: string): Response {
    let enabled = false;
    try {
      enabled = higgsfieldEnabled(this.env);
    } catch {
      enabled = false;
    }
    if (!enabled) throw new HttpError(400, "Higgsfield key not configured");
    const biz = this.get(id)!;
    if (!biz.heroImage) throw new HttpError(400, "Build the site first — the clip starts from the hero frame.");
    if (biz.video?.status === "rendering") return json({ ok: true, alreadyRendering: true }, 202);
    this.background(`video:${id}`, () => this.startVideoFor(id, true));
    return json({ ok: true }, 202);
  }

  private attachVideoUrl(id: string, body: Record<string, unknown>): Response {
    const url = normalizeUrl(body.url);
    if (!url) throw new HttpError(400, "Paste a full link to the video (https://…).");
    const biz = this.update(id, { video: { status: "ready", url, provider: "external" } })!;
    this.emit("Director", "success", `Launch ad attached to ${biz.name}'s preview (${hostOf(url)}).`, id, { stage: "director", video: "external" });
    return json(biz);
  }

  private removeBusiness(id: string, by: "operator" | "owner"): { ok: true } {
    const biz = this.get(id);
    if (!biz || biz.status === "removed") return { ok: true };
    const heroKey = biz.heroImage?.startsWith("/img/") ? decodeURIComponent(biz.heroImage.slice(5)) : null;
    this.running.delete(id); // any in-flight pipeline notices and aborts
    this.queued.delete(id);
    this.update(id, {
      status: "removed",
      brand: null,
      site: null,
      scores: [],
      pitch: null,
      heroImage: null,
      video: { status: "none" },
      error: null,
    });
    this.emit(
      "System",
      "info",
      by === "owner"
        ? `${biz.name} asked us to take their preview down. Done: the link now shows a removal notice, the images are deleted, and we won't re-scout them.`
        : `Removed ${biz.name}'s preview. The link now shows a removal notice and Scout will skip them.`,
      id,
      { removedBy: by },
    );
    this.background(`purge:${id}`, () => this.purgeMedia(`img:${id}:`, heroKey));
    return { ok: true };
  }

  private async purgeMedia(prefix: string, extraKey: string | null = null): Promise<void> {
    try {
      if (extraKey && !extraKey.startsWith(prefix)) await this.env.MEDIA.delete(extraKey).catch(() => undefined);
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await this.env.MEDIA.list({ prefix, cursor, limit: 1000 });
        await Promise.all(res.keys.map((k) => this.env.MEDIA.delete(k.name).catch(() => undefined)));
        if (res.list_complete) break;
        cursor = res.cursor;
      }
    } catch (err) {
      console.warn(`media purge for ${prefix} failed: ${errMsg(err)}`);
    }
  }

  private async reset(body: Record<string, unknown>): Promise<Response> {
    if (body.confirm !== "RESET") throw new HttpError(400, 'Send {"confirm":"RESET"} to wipe the board.');
    this.epoch++;
    this.running.clear();
    this.queued.clear();
    this.blockMembers.clear();
    this.lastViewEvent.clear();
    this.lastClaimEvent.clear();
    this.sql`DELETE FROM co_businesses`;
    this.sql`DELETE FROM co_events`;
    this.cache = new Map();
    try {
      const schedules = await this.listSchedules();
      await Promise.all(schedules.filter((s) => s.callback === "pollVideoJob").map((s) => this.cancelSchedule(s.id).catch(() => false)));
    } catch (err) {
      console.warn(`schedule cleanup failed: ${errMsg(err)}`);
    }
    this.background("purge:all", () => this.purgeMedia("img:"));
    this.emit("System", "info", `Board wiped. Fresh start at 101 Townsend St. ${this.integrationLine()}`);
    this.send({ type: "snapshot", snapshot: this.snapshot() });
    return json({ ok: true });
  }

  // ─── Video (Higgsfield) ────────────────────────────────────────────────────

  private async startVideoFor(id: string, manual = false): Promise<void> {
    const biz = this.get(id);
    if (!biz || biz.status === "removed" || !biz.heroImage) return;
    if (biz.video?.status === "rendering" && biz.video.jobId) return;
    const epoch = this.epoch;
    const pub = this.publicUrl();
    const imageUrl = biz.heroImage.startsWith("http") ? biz.heroImage : `${pub}${biz.heroImage}`;
    let prompt = "";
    try {
      if (biz.brand) prompt = suggestVideoPrompt(biz.brand, biz.category);
    } catch {
      prompt = "";
    }
    if (!prompt) {
      const vibe = biz.brand?.vibe ? ` ${biz.brand.vibe}.` : "";
      prompt =
        `Slow cinematic push-in on this scene for ${biz.name}, a ${biz.category} in San Francisco.${vibe} ` +
        `Gentle natural motion: drifting light, steam, leaves. Warm and inviting. No text, no logos.`;
    }
    this.update(id, { video: { status: "rendering", provider: "higgsfield" } });
    this.emit("Director", "info", `${manual ? "Re-rolling" : "Sending"} the hero frame to Higgsfield for a short launch clip.`, id, {
      stage: "video",
      phase: "start",
    });
    try {
      const started = await withTimeout(startVideo(this.env, { imageUrl, prompt }), 90_000, "Higgsfield start");
      const jobId = started.jobId;
      const cur = this.get(id);
      if (!cur || cur.status === "removed" || epoch !== this.epoch) return;
      this.update(id, { video: { status: "rendering", provider: "higgsfield", jobId } });
      const model = (started as { modelLabel?: string }).modelLabel;
      this.emit(
        "Director",
        "info",
        `Higgsfield job ${clip(jobId, 14)} is rendering${model ? ` on ${model}` : ""} — checking every ${VIDEO_POLL_SECONDS}s.`,
        id,
        { stage: "video", phase: "rendering", jobId, model },
      );
      await this.schedule(VIDEO_POLL_SECONDS, "pollVideoJob", { id, jobId, startedAt: Date.now() });
    } catch (err) {
      const cur = this.get(id);
      if (!cur || cur.status === "removed" || epoch !== this.epoch) return;
      this.update(id, { video: { status: "error", provider: "higgsfield", error: errMsg(err) } });
      this.emit("Director", "warn", `Higgsfield couldn't start the clip for ${cur.name} (${errMsg(err)}). The site is unaffected.`, id, {
        stage: "video",
        phase: "error",
      });
    }
  }

  /** Scheduled callback (via this.schedule) — polls a Higgsfield job until ready/error/10 min. */
  async resumeInterrupted(payload: { ids: string[] }): Promise<void> {
    for (const id of payload?.ids || []) {
      const b = this.get(id);
      if (!b || b.status !== "error" || !/interrupted/i.test(b.error || "")) continue;
      try {
        this.buildRoute(id);
      } catch (e) {
        console.warn(`[hq] resume ${id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  async pollVideoJob(payload: { id: string; jobId: string; startedAt: number }): Promise<void> {
    if (!payload?.id || !payload.jobId) return;
    const still = () => {
      const b = this.get(payload.id);
      return b && b.status !== "removed" && b.video?.jobId === payload.jobId && b.video.status === "rendering" ? b : null;
    };
    const biz = still();
    if (!biz) return;
    const elapsed = Date.now() - (payload.startedAt || Date.now());
    const giveUp = (reason: string) => {
      if (!still()) return;
      this.update(payload.id, (b) => ({ video: { ...b.video, status: "error", error: reason } }));
      this.emit("Director", "warn", `Launch clip for ${biz.name} didn't make it: ${reason}. The site is unaffected.`, payload.id, {
        stage: "video",
        phase: "error",
      });
    };
    try {
      const res = await withTimeout(pollVideo(this.env, payload.jobId), 20_000, "Higgsfield poll");
      if (!still()) return;
      if (res.status === "ready" && res.url) {
        this.update(payload.id, (b) => ({ video: { ...b.video, status: "ready", url: res.url, error: undefined } }));
        this.emit("Director", "success", `Launch clip for ${biz.name} is ready after ${fmtMs(elapsed)} — it's on the preview now.`, payload.id, {
          stage: "video",
          phase: "done",
          ms: elapsed,
          url: res.url,
        });
        if (slackEnabled(this.env)) {
          this.ctx.waitUntil(notifySlack(this.env, `*Cold Open · Director* launch clip ready for ${slackLink(`${this.publicUrl()}/s/${payload.id}`, biz.name)}.`));
        }
        return;
      }
      if (res.status === "error" || (res.status === "ready" && !res.url)) {
        giveUp(res.error || "Higgsfield reported an error");
        return;
      }
      if (elapsed > VIDEO_MAX_MS) {
        giveUp("still rendering after 10 minutes");
        return;
      }
      await this.schedule(VIDEO_POLL_SECONDS, "pollVideoJob", payload);
    } catch (err) {
      const retryable = (err as { retryable?: boolean })?.retryable !== false;
      if (!retryable) {
        giveUp(errMsg(err));
        return;
      }
      if (elapsed > VIDEO_MAX_MS) {
        giveUp(`poll kept failing (${errMsg(err)})`);
        return;
      }
      try {
        await this.schedule(VIDEO_POLL_SECONDS * 2, "pollVideoJob", payload);
      } catch (e) {
        giveUp(`couldn't schedule the next check (${errMsg(e)})`);
      }
    }
  }

  // ─── Views & payments ──────────────────────────────────────────────────────

  private noteView(biz: Business, ua: string): void {
    if (biz.status === "removed" || !biz.site || BOT_UA.test(ua)) return;
    const last = this.lastViewEvent.get(biz.id) ?? 0;
    if (Date.now() - last < VIEW_EVENT_THROTTLE_MS) return;
    this.lastViewEvent.set(biz.id, Date.now());
    this.emit("Closer", "info", `Someone just opened ${biz.name}'s preview.`, biz.id, { stage: "view" });
  }

  private markPaid(
    id: string,
    opts: { verified: boolean; amountCents: number | null; source: "webhook" | "redirect"; sessionId?: string | null },
  ): Business | null {
    const biz = this.get(id);
    if (!biz) return null;
    const amount = opts.amountCents != null && opts.amountCents > 0 ? Math.round(opts.amountCents) : LAUNCH_PACK_CENTS;

    if (biz.paidAt != null) {
      if (opts.verified && !biz.paymentVerified) {
        const up = this.update(id, { paymentVerified: true, amountCents: amount });
        this.emit("CFO", "success", `Stripe confirmed ${biz.name}'s payment — ${fmtMoney(amount)} is verified revenue now.`, id, {
          amountCents: amount,
          verified: true,
          source: opts.source,
        });
        return up;
      }
      return biz; // idempotent
    }

    const next = this.update(id, (b) => ({
      status: b.status === "removed" ? "removed" : "paid",
      paidAt: Date.now(),
      amountCents: amount,
      paymentVerified: opts.verified,
    }))!;
    const how = opts.verified
      ? "verified by Stripe"
      : stripeApiEnabled(this.env)
        ? "via the Stripe redirect — Stripe couldn't confirm it yet"
        : "via the Stripe redirect (unverified: no Stripe API key configured)";
    this.emit("Closer", "money", `${biz.name} just claimed their site — ${fmtMoney(amount)}, ${how}.`, id, {
      amountCents: amount,
      verified: opts.verified,
      source: opts.source,
      sessionId: opts.sessionId ?? undefined,
    });
    const stats = this.computeStats();
    const roi = stats.spendCents > 0 ? ` — ${Math.max(1, Math.round(stats.revenueCents / stats.spendCents)).toLocaleString("en-US")}× return on model spend` : "";
    this.emit(
      "CFO",
      "money",
      `Revenue is ${fmtMoney(stats.revenueCents)} from ${plural(stats.paid, "claim")} against ${fmtSpend(stats.spendCents)} of model spend${roi}.`,
      id,
      { revenueCents: stats.revenueCents, spendCents: stats.spendCents },
    );
    if (slackEnabled(this.env)) {
      this.ctx.waitUntil(
        notifySlack(
          this.env,
          `*Cold Open · PAID* ${slackLink(`${this.publicUrl()}/s/${id}`, biz.name)} claimed their site: ${fmtMoney(amount)} (${opts.verified ? "verified by Stripe" : "unverified redirect"}). Revenue now ${fmtMoney(stats.revenueCents)}.`,
        ),
      );
    }
    return next;
  }

  private async handleClaimed(body: Record<string, unknown>): Promise<Response> {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : null;
    const cookieId = typeof body.cookieId === "string" && /^[a-z0-9-]{1,80}$/.test(body.cookieId) ? body.cookieId : null;

    if (sessionId && stripeApiEnabled(this.env) && isCheckoutSessionId(sessionId)) {
      const r = await retrieveSession(this.env, sessionId);
      if (r.ok) {
        const s = r.session;
        const bizId = s.client_reference_id || s.metadata?.business_id || cookieId;
        const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
        const biz = bizId ? this.get(bizId) : null;
        if (paid) {
          if (biz) {
            const b = this.markPaid(biz.id, { verified: true, amountCents: s.amount_total, source: "redirect", sessionId: s.id });
            return json({ business: b, verified: true, paid: true });
          }
          this.emit("CFO", "warn", `A verified ${fmtMoney(s.amount_total ?? LAUNCH_PACK_CENTS)} payment landed with no business attached (session …${s.id.slice(-6)}).`, undefined, {
            amountCents: s.amount_total,
          });
          return json({ business: null, verified: true, paid: true });
        }
        if (biz) {
          this.emit("Closer", "info", `Checkout for ${biz.name} came back ${s.payment_status} — not counting it until Stripe says paid.`, biz.id);
        }
        return json({ business: null, verified: false, paid: false });
      }
      this.emit("CFO", "warn", `Couldn't verify checkout session …${sessionId.slice(-6)} with Stripe (${r.error}). Falling back to the claim cookie.`);
    }

    if (cookieId) {
      const biz = this.get(cookieId);
      if (biz) {
        const b = this.markPaid(biz.id, { verified: false, amountCents: LAUNCH_PACK_CENTS, source: "redirect", sessionId });
        return json({ business: b, verified: false, paid: true });
      }
    }
    return json({ business: null, verified: false, paid: false });
  }

  private async stripeWebhook(request: Request): Promise<Response> {
    const raw = await request.arrayBuffer();
    let event: StripeEvent;
    let trusted = false;
    if (stripeWebhookEnabled(this.env)) {
      const v = await verifyWebhook(this.env, raw, request.headers.get("stripe-signature"));
      if (!v.ok) {
        console.warn(`rejected Stripe webhook: ${v.error}`);
        return json({ error: v.error }, 400);
      }
      event = v.event;
      trusted = true;
    } else {
      try {
        event = JSON.parse(new TextDecoder().decode(raw)) as StripeEvent;
      } catch {
        return json({ error: "Body must be a Stripe event (JSON)." }, 400);
      }
      if (!event || typeof event.type !== "string" || !event.data?.object) return json({ error: "Not a Stripe event." }, 400);
    }

    if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
      return json({ received: true, ignored: event.type });
    }

    let session = event.data.object as unknown as StripeCheckoutSession;
    if (!trusted) {
      // No signing secret: the only way to trust the event is to re-read the session from Stripe.
      if (stripeApiEnabled(this.env) && isCheckoutSessionId(session?.id)) {
        const r = await retrieveSession(this.env, session.id);
        if (!r.ok) return json({ error: `Could not verify session with Stripe: ${r.error}` }, 400);
        session = r.session;
        trusted = true;
      }
    }

    const paid = session?.payment_status === "paid" || session?.payment_status === "no_payment_required";
    const bizId = session?.client_reference_id || session?.metadata?.business_id || null;
    if (!paid) return json({ received: true, paid: false });
    if (!bizId || !this.get(bizId)) {
      this.emit("CFO", "warn", `Stripe reported a ${fmtMoney(session?.amount_total ?? LAUNCH_PACK_CENTS)} payment without a matching business (client_reference_id missing).`);
      return json({ received: true, matched: false });
    }
    this.markPaid(bizId, { verified: trusted, amountCents: session.amount_total ?? null, source: "webhook", sessionId: session.id });
    return json({ received: true, matched: true, verified: trusted });
  }
}
