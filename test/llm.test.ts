import { describe, expect, it } from "vitest";
import { addCost, llmJSON, llmProviderLabel, parseJsonLoose, takeCost } from "../src/llm";
import { jsonResponse, makeEnv, stubFetch } from "./fixtures";

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose('{"score": 91, "ok": true}')).toEqual({ score: 91, ok: true });
  });

  it("strips ```json code fences", () => {
    expect(parseJsonLoose('```json\n{"headline": "Toast on King"}\n```')).toEqual({ headline: "Toast on King" });
    expect(parseJsonLoose('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("ignores prose before and after the object", () => {
    const raw = 'Sure! Here is the JSON you asked for:\n{"verdict": "Clean page.", "score": 88}\nLet me know if you want changes.';
    expect(parseJsonLoose(raw)).toEqual({ verdict: "Clean page.", score: 88 });
  });

  it("removes trailing commas in objects and arrays", () => {
    expect(parseJsonLoose('{"a": [1, 2, 3,], "b": {"c": "d",},}')).toEqual({ a: [1, 2, 3], b: { c: "d" } });
  });

  it("closes a reply truncated mid-object and drops the incomplete member", () => {
    const truncated =
      '{"headline": "Hi", "about": "Some text", "highlights": [{"title": "A", "text": "B"}, {"title": "C", "te';
    expect(parseJsonLoose(truncated)).toEqual({
      headline: "Hi",
      about: "Some text",
      highlights: [{ title: "A", text: "B" }, { title: "C" }],
    });
  });

  it("closes a reply truncated inside a string value", () => {
    expect(parseJsonLoose('{"a": 1, "b": "unfinished sent')).toEqual({ a: 1 });
  });

  it("skips <think> reasoning blocks, even when they contain braces", () => {
    expect(parseJsonLoose('<think>maybe {"x": 1}?</think>{"y": 2}')).toEqual({ y: 2 });
    expect(parseJsonLoose('<thinking>{"x": 1}</thinking>\n{"y": 3}')).toEqual({ y: 3 });
  });

  it("is string-aware: braces and escaped quotes inside values do not end the object", () => {
    expect(parseJsonLoose('{"a": "has } and { braces", "b": "say \\"hi\\"", "c": 2} trailing')).toEqual({
      a: "has } and { braces",
      b: 'say "hi"',
      c: 2,
    });
  });

  it("repairs bare and smart-quoted keys as a last resort", () => {
    expect(parseJsonLoose("{score: 90, pass: true}")).toEqual({ score: 90, pass: true });
    expect(parseJsonLoose("{“score”: 77}")).toEqual({ score: 77 });
  });

  it("returns only the first complete object", () => {
    expect(parseJsonLoose('{"first": 1} {"second": 2}')).toEqual({ first: 1 });
  });

  it("passes already-parsed objects through untouched", () => {
    const obj = { already: "parsed" };
    expect(parseJsonLoose(obj)).toBe(obj);
  });

  it("returns null for non-JSON input", () => {
    expect(parseJsonLoose("no json here")).toBeNull();
    expect(parseJsonLoose("")).toBeNull();
    expect(parseJsonLoose(undefined)).toBeNull();
    expect(parseJsonLoose(42)).toBeNull();
    expect(parseJsonLoose("[1, 2, 3]")).toBeNull(); // top-level arrays are not agent replies
  });
});

describe("cost ledger", () => {
  it("accumulates per business and resets on take", () => {
    addCost("biz-ledger", 0.25);
    addCost("biz-ledger", 0.5);
    addCost("biz-ledger", -3); // ignored
    addCost("biz-ledger", Number.NaN); // ignored
    addCost("", 10); // ignored
    expect(takeCost("biz-ledger")).toBe(0.75);
    expect(takeCost("biz-ledger")).toBe(0);
  });
});

describe("llmProviderLabel (key-prefix routing)", () => {
  it("uses Claude for an sk-ant- key", () => {
    expect(llmProviderLabel(makeEnv({ ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_MODEL: "claude-sonnet-5" }))).toBe("claude-sonnet-5");
    expect(llmProviderLabel(makeEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }))).toBe("claude-sonnet-5"); // default model
  });

  it("routes an OpenAI key to OpenAI even when it was stored as ANTHROPIC_API_KEY", () => {
    expect(llmProviderLabel(makeEnv({ ANTHROPIC_API_KEY: "sk-proj-test" }))).toBe("OpenAI gpt-5-mini");
    expect(llmProviderLabel(makeEnv({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4.1-mini" }))).toBe("OpenAI gpt-4.1-mini");
  });

  it("falls back to Workers AI when no key is configured", () => {
    expect(llmProviderLabel(makeEnv())).toBe("workers-ai:llama-3.3-70b");
  });
});

describe("llmJSON provider chain", () => {
  const args = { system: "You are a test.", prompt: "Return JSON.", maxTokens: 100 };

  it("calls Anthropic for an sk-ant- key, parses fenced JSON and prices the call", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({
        content: [{ type: "text", text: '```json\n{"ok": true}\n```' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
    );
    const res = await llmJSON<{ ok: boolean }>(makeEnv({ ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_MODEL: "claude-sonnet-5" }), args);
    expect(res.data).toEqual({ ok: true });
    expect(res.provider).toBe("claude-sonnet-5");
    // sonnet-5 is priced at $2 in / $10 out per million tokens: (1000*2 + 100*10) / 1e6 dollars = 0.3 cents
    expect(res.costCents).toBeCloseTo(0.3, 6);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-test");
    const body = JSON.parse(calls[0].body!);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.system).toContain("respond with exactly one JSON object");
  });

  it("sends a misfiled sk- key to OpenAI, never to Anthropic", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ model: "gpt-5-mini", choices: [{ message: { content: '{"ok": 1}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    );
    const res = await llmJSON(makeEnv({ ANTHROPIC_API_KEY: "sk-proj-test" }), args);
    expect(res.data).toEqual({ ok: 1 });
    expect(res.provider).toBe("OpenAI gpt-5-mini");
    expect(calls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/chat/completions"]);
    expect(calls[0].headers["authorization"]).toBe("Bearer sk-proj-test");
  });

  it("falls through to the next provider when one fails", async () => {
    const { calls } = stubFetch((c) =>
      c.url.includes("anthropic")
        ? new Response("overloaded", { status: 529 })
        : jsonResponse({ model: "gpt-5-mini", choices: [{ message: { content: '{"from": "openai"}' } }] }),
    );
    const res = await llmJSON(makeEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-openai-test" }), args);
    expect(res.data).toEqual({ from: "openai" });
    expect(calls[0].url).toContain("api.anthropic.com");
    expect(calls[calls.length - 1].url).toContain("api.openai.com");
  });

  it("retries once with a JSON-only nudge when the first reply is not JSON", async () => {
    let n = 0;
    const { calls } = stubFetch(() =>
      jsonResponse({
        model: "gpt-5-mini",
        choices: [{ message: { content: n++ === 0 ? "I think the site is great." : '{"fixed": true}' } }],
      }),
    );
    const res = await llmJSON(makeEnv({ OPENAI_API_KEY: "sk-test" }), args);
    expect(res.data).toEqual({ fixed: true });
    expect(calls).toHaveLength(2);
    const secondPrompt = JSON.parse(calls[1].body!).messages[1].content as string;
    expect(secondPrompt).toContain("could not be parsed");
  });

  it("throws a combined error when no provider is configured", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    await expect(llmJSON(makeEnv(), args)).rejects.toThrow(/All LLM providers failed/);
    expect(calls).toHaveLength(0);
  });
});
