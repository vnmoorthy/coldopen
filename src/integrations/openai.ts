// OpenAI provider. Keys are detected by prefix so a key pasted into the
// "wrong" secret still routes to the right API:
//   sk-ant-...           → Anthropic (handled in llm.ts)
//   sk-... (not sk-ant-) → OpenAI, whether stored as OPENAI_API_KEY or ANTHROPIC_API_KEY
import type { Env } from "../types";

export function isAnthropicKey(key: string | undefined): boolean {
  return !!key && key.startsWith("sk-ant-");
}

export function openaiKey(env: Env): string | null {
  const direct = (env as Env & { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
  if (direct && direct.startsWith("sk-")) return direct;
  const misfiled = env.ANTHROPIC_API_KEY;
  if (misfiled && misfiled.startsWith("sk-") && !isAnthropicKey(misfiled)) return misfiled;
  return null;
}

export function openaiEnabled(env: Env): boolean {
  return openaiKey(env) !== null;
}

export function openaiModel(env: Env): string {
  return (env as Env & { OPENAI_MODEL?: string }).OPENAI_MODEL || "gpt-5-mini";
}

const FALLBACK_MODELS = ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"];

export interface OpenAIText {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// Returns raw text (the caller parses JSON). Throws on failure so the caller can fall back.
export async function openaiComplete(
  env: Env,
  args: { system: string; prompt: string; maxTokens?: number; temperature?: number },
): Promise<OpenAIText> {
  const key = openaiKey(env);
  if (!key) throw new Error("OpenAI key not configured");
  const models = [openaiModel(env), ...FALLBACK_MODELS.filter((m) => m !== openaiModel(env))];
  let lastErr = "unknown error";
  for (const model of models) {
    const reasoning = /^(gpt-5|o\d)/.test(model);
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.prompt },
      ],
      response_format: { type: "json_object" },
    };
    if (reasoning) {
      body.max_completion_tokens = Math.max(2000, (args.maxTokens ?? 1500) * 3);
      body.reasoning_effort = "low";
    } else {
      body.max_tokens = args.maxTokens ?? 1500;
      if (args.temperature !== undefined) body.temperature = args.temperature;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 300);
        lastErr = `OpenAI ${res.status} (${model}): ${errText}`;
        // Unknown model or unsupported parameter: try the next model. Auth errors: stop.
        if (res.status === 401 || res.status === 403 || res.status === 429) break;
        continue;
      }
      const json = (await res.json()) as {
        model?: string;
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      if (!text) {
        lastErr = `OpenAI returned empty content (${model})`;
        continue;
      }
      return {
        text,
        model: json.model || model,
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      };
    } catch (e) {
      lastErr = `OpenAI request failed (${model}): ${(e as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr);
}
