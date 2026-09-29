import { describe, expect, it } from "vitest";
import { isAnthropicKey, openaiComplete, openaiEnabled, openaiKey, openaiModel } from "../src/integrations/openai";
import { jsonResponse, makeEnv, stubFetch } from "./fixtures";

describe("key-prefix routing", () => {
  it("recognizes Anthropic keys by the sk-ant- prefix only", () => {
    expect(isAnthropicKey("sk-ant-api03-abc")).toBe(true);
    expect(isAnthropicKey("sk-proj-abc")).toBe(false);
    expect(isAnthropicKey("sk-abc")).toBe(false);
    expect(isAnthropicKey("")).toBe(false);
    expect(isAnthropicKey(undefined)).toBe(false);
  });

  it("prefers OPENAI_API_KEY when it looks like an OpenAI key", () => {
    const env = makeEnv({ OPENAI_API_KEY: "sk-proj-direct", ANTHROPIC_API_KEY: "sk-proj-misfiled" });
    expect(openaiKey(env)).toBe("sk-proj-direct");
  });

  it("rescues an OpenAI key pasted into ANTHROPIC_API_KEY", () => {
    expect(openaiKey(makeEnv({ ANTHROPIC_API_KEY: "sk-proj-misfiled" }))).toBe("sk-proj-misfiled");
    expect(openaiEnabled(makeEnv({ ANTHROPIC_API_KEY: "sk-proj-misfiled" }))).toBe(true);
  });

  it("never treats an Anthropic key as an OpenAI key", () => {
    expect(openaiKey(makeEnv({ ANTHROPIC_API_KEY: "sk-ant-real" }))).toBeNull();
    expect(openaiEnabled(makeEnv({ ANTHROPIC_API_KEY: "sk-ant-real" }))).toBe(false);
  });

  it("ignores values that are not keys at all", () => {
    expect(openaiKey(makeEnv({ OPENAI_API_KEY: "not-a-key" }))).toBeNull();
    expect(openaiEnabled(makeEnv())).toBe(false);
  });

  it("defaults the model to gpt-5-mini and honors OPENAI_MODEL", () => {
    expect(openaiModel(makeEnv())).toBe("gpt-5-mini");
    expect(openaiModel(makeEnv({ OPENAI_MODEL: "gpt-4o-mini" }))).toBe("gpt-4o-mini");
  });
});

describe("openaiComplete", () => {
  const args = { system: "sys", prompt: "hi", maxTokens: 500, temperature: 0.3 };

  it("throws before any request when no key is configured", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    await expect(openaiComplete(makeEnv(), args)).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0);
  });

  it("uses reasoning parameters for gpt-5 models", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ model: "gpt-5-mini", choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    );
    const out = await openaiComplete(makeEnv({ OPENAI_API_KEY: "sk-test" }), args);
    expect(out).toEqual({ text: '{"a":1}', model: "gpt-5-mini", inputTokens: 12, outputTokens: 3 });
    const body = JSON.parse(calls[0].body!);
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_completion_tokens).toBe(2000); // max(2000, 500 * 3)
    expect(body.temperature).toBeUndefined();
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("falls back to the next model when a model is unavailable", async () => {
    const { calls } = stubFetch((c) => {
      const model = JSON.parse(c.body!).model;
      return model === "gpt-5-mini"
        ? jsonResponse({ error: { message: "model not found" } }, 404)
        : jsonResponse({ model, choices: [{ message: { content: '{"b":2}' } }] });
    });
    const out = await openaiComplete(makeEnv({ OPENAI_API_KEY: "sk-test" }), args);
    expect(out.model).toBe("gpt-4.1-mini");
    expect(calls).toHaveLength(2);
    const second = JSON.parse(calls[1].body!);
    expect(second.max_tokens).toBe(500); // non-reasoning model: classic params
    expect(second.temperature).toBe(0.3);
  });

  it("stops immediately on an auth error instead of burning through fallbacks", async () => {
    const { calls } = stubFetch(() => jsonResponse({ error: { message: "bad key" } }, 401));
    await expect(openaiComplete(makeEnv({ OPENAI_API_KEY: "sk-test" }), args)).rejects.toThrow(/OpenAI 401/);
    expect(calls).toHaveLength(1);
  });
});
