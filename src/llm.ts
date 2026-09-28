// llmJSON(): one call site for every agent's "brain".
// Claude (sk-ant- key) -> OpenAI (sk- key, either secret) -> Workers AI Llama 3.3 70B -> Workers AI gpt-oss-120b.
// Always returns parsed JSON (robust to fences, prose, trailing commas and truncation) or throws.

import type { Env, LlmResult } from "./types";

import { isAnthropicKey, openaiComplete, openaiEnabled, openaiModel } from "./integrations/openai";

export interface LlmArgs {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Claude effort hint (ignored by models that do not support it). Default "low" for stage speed. */
  effort?: "low" | "medium" | "high";
  /** Workers AI only: "smart" tries the reasoning model (gpt-oss-120b) before Llama 3.3. */
  prefer?: "fast" | "smart";
}

const CLAUDE_TIMEOUT_MS = 45_000;
const WORKERS_AI_TIMEOUT_MS = 60_000;
const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const GPT_OSS = "@cf/openai/gpt-oss-120b";
const LLAMA_LABEL = "workers-ai:llama-3.3-70b";
const GPT_OSS_LABEL = "workers-ai:gpt-oss-120b";

const JSON_RULE =
  "\n\nOutput format: respond with exactly one JSON object and nothing else. No markdown, no code fences, no commentary before or after.";
const JSON_NUDGE =
  "\n\nIMPORTANT: your previous reply could not be parsed. Return valid JSON only: one object, double-quoted keys and strings, no trailing commas, no prose, no code fences.";

// ---------------------------------------------------------------------------------------------
// Optional per-business cost ledger. The pipeline stages report spend by return value, so they do
// not write here; the orchestrator may still drain it (it takes max(returned, drained)).
const ledger = new Map<string, number>();

export function addCost(bizId: string, cents: number): void {
  if (!bizId || !Number.isFinite(cents) || cents <= 0) return;
  ledger.set(bizId, (ledger.get(bizId) || 0) + cents);
}

/** Returns and resets the spend (cents) recorded via addCost() for a business. */
export function takeCost(bizId: string): number {
  const v = ledger.get(bizId) || 0;
  ledger.delete(bizId);
  return round4(v);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------------------------
// Provider labels & pricing (USD per million tokens; estimates, shown as estimates in the UI)

function claudeModel(env: Env): string {
  return (env.CLAUDE_MODEL || "").trim() || "claude-sonnet-5";
}

export function llmProviderLabel(env: Env): string {
  if (isAnthropicKey(env.ANTHROPIC_API_KEY)) return claudeModel(env);
  if (openaiEnabled(env)) return `OpenAI ${openaiModel(env)}`;
  return LLAMA_LABEL;
}

function claudePrice(model: string): [number, number] {
  const m = model.toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return [10, 50];
  if (m.includes("opus-4-5") || m.includes("opus-4-6") || m.includes("opus-4-7") || m.includes("opus-4-8") || m.includes("opus-5")) return [5, 25];
  if (m.includes("opus")) return [15, 75];
  if (m.includes("haiku")) return [1, 5];
  if (m.includes("sonnet-5")) return [2, 10];
  return [3, 15]; // sonnet 4.x and anything unknown
}

function centsFor(inTok: number, outTok: number, price: [number, number]): number {
  return round4(((inTok * price[0] + outTok * price[1]) / 1_000_000) * 100);
}

const estTokens = (s: string) => Math.ceil((s || "").length / 4);

// ---------------------------------------------------------------------------------------------
// Robust JSON extraction

/** Parses the first JSON object found in a model reply. Handles code fences, <think> blocks,
 *  surrounding prose, smart quotes, trailing commas and replies truncated mid-object. */
export function parseJsonLoose<T = unknown>(raw: unknown): T | null {
  if (raw && typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return null;
  let s = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/```(?:json|JSON)?/g, "")
    .trim();
  const start = s.indexOf("{");
  if (start < 0) return null;
  s = s.slice(start);

  // Scan for the matching close brace (string-aware).
  let depth = 0;
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      depth++;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const attempts: string[] = [];
  if (end >= 0) {
    const candidate = s.slice(0, end + 1);
    attempts.push(candidate, stripTrailingCommas(candidate), repairJson(candidate));
  } else {
    attempts.push(closeTruncated(s));
  }
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object") return v as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

function stripTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}

/** Last-resort repair: smart-quoted or bare keys. Only used after strict parses failed. */
function repairJson(s: string): string {
  return stripTrailingCommas(s)
    .replace(/([{,]\s*)[“”]([^“”"]+)[“”]\s*:/g, '$1"$2":')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
}

/** Closes a JSON object that was cut off (max tokens). Drops the incomplete trailing member. */
function closeTruncated(s: string): string {
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let lastSafe = -1; // index after the last complete value at any depth
  let safeStack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      lastSafe = i + 1;
      safeStack = stack.slice();
    } else if (ch === ",") {
      lastSafe = i; // cut before the comma
      safeStack = stack.slice();
    }
  }
  if (lastSafe < 0) return s;
  const body = s.slice(0, lastSafe).replace(/,\s*$/, "");
  return stripTrailingCommas(body + safeStack.reverse().join(""));
}

// ---------------------------------------------------------------------------------------------
// Providers

interface RawCall {
  text: unknown; // string or already-parsed object
  inTok: number;
  outTok: number;
  model: string;
  label: string;
  price: [number, number];
}

async function callClaude(env: Env, args: LlmArgs, prompt: string): Promise<RawCall> {
  const model = claudeModel(env);
  const maxTokens = Math.min(16000, (args.maxTokens ?? 2000) + 4000); // headroom for adaptive thinking
  const supportsEffort = /sonnet-5|sonnet-4-6|opus-4-[5-9]|opus-5|fable|mythos/i.test(model);
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: args.system + JSON_RULE,
    messages: [{ role: "user", content: prompt }],
  };
  if (supportsEffort) body.output_config = { effort: args.effort || "low" };

  const send = async (b: Record<string, unknown>) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY as string,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    });

  let res = await send(body);
  if (res.status === 400 && body.output_config) {
    const errText = await res.text();
    if (/output_config|effort/i.test(errText)) {
      delete body.output_config;
      res = await send(body);
    } else {
      throw new Error(`anthropic 400: ${errText.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  if (json.stop_reason === "refusal") throw new Error("anthropic refusal");
  const text = (json.content || [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  if (!text.trim()) throw new Error(`anthropic empty reply (stop_reason=${json.stop_reason})`);
  const u = json.usage || {};
  return {
    text,
    inTok: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    outTok: u.output_tokens || estTokens(text),
    model,
    label: model,
    price: claudePrice(model),
  };
}

type AiRunner = { run: (model: string, input: unknown, options?: unknown) => Promise<unknown> };

// Circuit breaker: when the account's Workers AI allocation is used up (error 4006 on the free plan)
// every call fails the same way, so stop calling it for a while and fail fast instead. The free
// allocation resets at 00:00 UTC; we re-probe every 10 minutes in case the plan was upgraded.
// State is per isolate (the HQ Durable Object's isolate is where the pipeline runs).
let workersAiBlockedUntil = 0;
let workersAiQuotaHitAt = 0;
const QUOTA_RE = /\b4006\b|daily free allocation|neurons|workers paid plan/i;
const BREAKER_MS = 10 * 60_000;

function nextUtcMidnight(from = Date.now()): number {
  const d = new Date(from);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export interface WorkersAiStatus {
  ok: boolean;
  quotaExhausted: boolean;
  reason: string | null; // e.g. "quota exhausted until 00:00 UTC"
  retryAt: number | null; // when the breaker lets the next call through
  resetsAt: number | null; // next 00:00 UTC when the free allocation refills
}

/** Whether Workers AI is currently usable, and why not (for /api/config and UI pills). */
export function workersAiStatus(): WorkersAiStatus {
  const now = Date.now();
  const resetsAt = workersAiQuotaHitAt ? nextUtcMidnight(workersAiQuotaHitAt) : null;
  const quotaExhausted = !!resetsAt && now < resetsAt && workersAiQuotaHitAt > 0;
  const blocked = now < workersAiBlockedUntil;
  return {
    ok: !blocked,
    quotaExhausted,
    reason: quotaExhausted ? "quota exhausted until 00:00 UTC" : null,
    retryAt: blocked ? workersAiBlockedUntil : null,
    resetsAt: quotaExhausted ? resetsAt : null,
  };
}

/** env.AI.run with a timeout, an abort signal and the quota circuit breaker. Shared by all agents. */
export async function aiRun(env: Env, model: string, input: unknown, timeoutMs = WORKERS_AI_TIMEOUT_MS): Promise<unknown> {
  if (!env.AI) throw new Error("Workers AI binding missing");
  if (Date.now() < workersAiBlockedUntil) throw new Error("Workers AI quota exhausted until 00:00 UTC (circuit open)");
  try {
    const out = await aiRunRaw(env, model, input, timeoutMs);
    workersAiQuotaHitAt = 0; // a success means the allocation is back (reset or upgraded)
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (QUOTA_RE.test(msg)) {
      workersAiQuotaHitAt = Date.now();
      workersAiBlockedUntil = Math.min(Date.now() + BREAKER_MS, nextUtcMidnight());
    }
    throw e;
  }
}

async function aiRunRaw(env: Env, model: string, input: unknown, timeoutMs: number): Promise<unknown> {
  const ai = env.AI as unknown as AiRunner;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      ctrl.abort();
      rej(new Error(`${model} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([ai.run(model, input, { signal: ctrl.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function usageOf(out: unknown): { inTok?: number; outTok?: number } {
  const u = (out as { usage?: Record<string, number> } | null)?.usage;
  if (!u) return {};
  return {
    inTok: u.prompt_tokens ?? u.input_tokens,
    outTok: u.completion_tokens ?? u.output_tokens,
  };
}

/** Pulls the model text (or already-parsed JSON) out of any Workers AI response shape. */
function workersAiText(out: unknown): unknown {
  if (typeof out === "string") return out;
  if (!out || typeof out !== "object") return null;
  const o = out as Record<string, unknown>;
  if (o.response !== undefined && o.response !== null) return o.response; // llama: string or parsed object
  if (typeof o.output_text === "string" && o.output_text) return o.output_text; // responses API
  const choices = o.choices as { message?: { content?: unknown } }[] | undefined;
  if (Array.isArray(choices) && choices[0]?.message?.content) return choices[0].message.content;
  const output = o.output as { type?: string; content?: { type?: string; text?: string }[] }[] | undefined;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) if (typeof c?.text === "string") texts.push(c.text);
      }
    }
    if (texts.length) return texts.join("\n");
  }
  return null;
}

async function callLlama(env: Env, args: LlmArgs, prompt: string, jsonMode: boolean): Promise<RawCall> {
  const messages = [
    { role: "system", content: args.system + JSON_RULE },
    { role: "user", content: prompt },
  ];
  const input: Record<string, unknown> = {
    messages,
    max_tokens: Math.min(8000, args.maxTokens ?? 2000),
    temperature: args.temperature ?? 0.6,
  };
  if (jsonMode) input.response_format = { type: "json_object" };
  const out = await aiRun(env, LLAMA, input);
  const text = workersAiText(out);
  if (text === null || text === undefined || (typeof text === "string" && !text.trim())) throw new Error("llama empty reply");
  const u = usageOf(out);
  const textStr = typeof text === "string" ? text : JSON.stringify(text);
  return {
    text,
    inTok: u.inTok ?? estTokens(args.system + prompt),
    outTok: u.outTok ?? estTokens(textStr),
    model: LLAMA,
    label: LLAMA_LABEL,
    price: [0.29, 2.25],
  };
}

async function callGptOss(env: Env, args: LlmArgs, prompt: string): Promise<RawCall> {
  const system = args.system + JSON_RULE;
  let out: unknown;
  try {
    out = await aiRun(env, GPT_OSS, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: Math.min(12000, (args.maxTokens ?? 2000) + 3000),
      reasoning_effort: "low",
    });
  } catch (e) {
    if (!workersAiStatus().ok) throw e;
    out = await aiRun(env, GPT_OSS, {
      instructions: system,
      input: prompt,
      reasoning: { effort: "low" },
    });
  }
  const text = workersAiText(out);
  if (text === null || text === undefined || (typeof text === "string" && !text.trim())) throw new Error("gpt-oss empty reply");
  const u = usageOf(out);
  const textStr = typeof text === "string" ? text : JSON.stringify(text);
  return {
    text,
    inTok: u.inTok ?? estTokens(system + prompt),
    outTok: u.outTok ?? estTokens(textStr),
    model: GPT_OSS,
    label: GPT_OSS_LABEL,
    price: [0.35, 0.75],
  };
}

async function callOpenAI(env: Env, args: LlmArgs, prompt: string): Promise<RawCall> {
  const out = await openaiComplete(env, { system: args.system + JSON_RULE, prompt, maxTokens: args.maxTokens, temperature: args.temperature });
  return {
    text: out.text,
    inTok: out.inputTokens || estTokens(args.system + prompt),
    outTok: out.outputTokens || estTokens(out.text),
    model: out.model,
    label: `OpenAI ${out.model}`,
    price: /mini|nano/.test(out.model) ? [0.25, 2] : [1.25, 10],
  };
}

// ---------------------------------------------------------------------------------------------

type Attempt = (prompt: string) => Promise<RawCall>;

/** Runs one provider: call, parse; on a parse failure retry once with a JSON-only nudge. */
async function runProvider<T>(attempt: Attempt, prompt: string, spent: { cents: number }): Promise<{ data: T; call: RawCall }> {
  const first = await attempt(prompt);
  spent.cents += centsFor(first.inTok, first.outTok, first.price);
  const parsed = parseJsonLoose<T>(first.text);
  if (parsed) return { data: parsed, call: first };
  const second = await attempt(prompt + JSON_NUDGE);
  spent.cents += centsFor(second.inTok, second.outTok, second.price);
  const parsed2 = parseJsonLoose<T>(second.text);
  if (parsed2) return { data: parsed2, call: second };
  throw new Error(`${first.label}: reply was not valid JSON`);
}

export async function llmJSON<T>(
  env: Env,
  args: LlmArgs,
): Promise<LlmResult<T>> {
  const t0 = Date.now();
  const spent = { cents: 0 };
  const errors: string[] = [];

  const chain: { name: string; attempt: Attempt }[] = [];
  if (isAnthropicKey(env.ANTHROPIC_API_KEY)) chain.push({ name: "claude", attempt: (p) => callClaude(env, args, p) });
  if (openaiEnabled(env)) chain.push({ name: "openai", attempt: (p) => callOpenAI(env, args, p) });
  if (env.AI) {
    const workersAi: { name: string; attempt: Attempt }[] = [];
    workersAi.push({
      name: "llama",
      attempt: async (p) => {
        try {
          return await callLlama(env, args, p, true);
        } catch (e) {
          // JSON mode can reject ("JSON Mode couldn't be met"); plain mode + loose parsing still works.
          const msg = e instanceof Error ? e.message : String(e);
          if (/timed out/i.test(msg) || !workersAiStatus().ok) throw e;
          return await callLlama(env, args, p, false);
        }
      },
    });
    workersAi.push({ name: "gpt-oss", attempt: (p) => callGptOss(env, args, p) });
    if (args.prefer === "smart") workersAi.reverse();
    chain.push(...workersAi);
  }

  for (const step of chain) {
    try {
      const { data, call } = await runProvider<T>(step.attempt, args.prompt, spent);
      return { data, provider: call.label, model: call.model, costCents: round4(spent.cents), ms: Date.now() - t0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${step.name}: ${msg.slice(0, 160)}`);
      console.warn(`[llm] ${step.name} failed: ${msg.slice(0, 200)}`);
    }
  }
  const err = new Error(`All LLM providers failed — ${errors.join(" | ") || "no provider configured"}`);
  (err as Error & { costCents?: number }).costCents = round4(spent.cents);
  throw err;
}
