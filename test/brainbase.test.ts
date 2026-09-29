// Brainbase's parsing helpers (parseVerdict, lastAssistantText, contentText) are module-private,
// so they are exercised through the public reviewSite() with a stubbed Brainbase API.
import { describe, expect, it } from "vitest";
import * as brainbase from "../src/integrations/brainbase";
import { BRAINBASE_API_BASE, BRAINBASE_HARNESS, BRAINBASE_MODEL, brainbaseEnabled, reviewSite } from "../src/integrations/brainbase";
import { type FetchCall, jsonResponse, makeEnv, stubFetch } from "./fixtures";

const env = makeEnv({ BRAINBASE_API_KEY: "bb_unit_test" });
const ARGS = { bizName: "Harbor Lane Coffee", previewUrl: "https://coldopen.example.test/s/harbor-lane-coffee", brandSummary: "warm coffee counter" };

/** Brainbase API stub: thread creation finishes immediately (no polling) and the transcript is `items`. */
function brainbaseApi(items: unknown[], create: (c: FetchCall) => Response = () => jsonResponse({ thread_id: "th_1", status: "success" })) {
  return stubFetch((c) => {
    if (c.method === "POST" && c.url === `${BRAINBASE_API_BASE}/v2/threads`) return create(c);
    if (c.url.startsWith(`${BRAINBASE_API_BASE}/v2/threads/th_1/messages`)) return jsonResponse({ items });
    if (c.url === `${BRAINBASE_API_BASE}/v2/threads/th_1`) return jsonResponse({ id: "th_1", status: "success" });
    return jsonResponse({ error: "unexpected" }, 404);
  });
}

describe("brainbaseEnabled", () => {
  it("requires a non-blank key", () => {
    expect(brainbaseEnabled(makeEnv())).toBe(false);
    expect(brainbaseEnabled(makeEnv({ BRAINBASE_API_KEY: "   " }))).toBe(false);
    expect(brainbaseEnabled(env)).toBe(true);
  });
});

describe("reviewSite", () => {
  it("does nothing without a key", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    expect(await reviewSite(makeEnv(), ARGS)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("creates a claude_code thread and parses the JSON verdict from content blocks", async () => {
    const { calls } = brainbaseApi([
      { role: "user", content: "review this" },
      { role: "assistant", content: [{ type: "text", text: 'Here you go:\n{"verdict": "Clear headline.  Honest copy.", "score": 76}' }] },
    ]);
    const review = await reviewSite(env, ARGS);
    expect(review).toEqual({
      verdict: "Clear headline. Honest copy.",
      score: 76,
      threadId: "th_1",
      harness: BRAINBASE_HARNESS,
      model: BRAINBASE_MODEL,
    });
    const create = JSON.parse(calls[0].body!);
    expect(create.agent.harness).toBe("claude_code");
    expect(create.agent.model).toBe(BRAINBASE_MODEL);
    expect(create.input).toContain(ARGS.previewUrl);
    expect(calls[0].headers["authorization"]).toBe("Bearer bb_unit_test");
  });

  it("clamps out-of-range and string scores to an integer 0-100", async () => {
    brainbaseApi([{ role: "assistant", content: '{"verdict": "Fine.", "score": "146.4"}' }]);
    expect((await reviewSite(env, ARGS))?.score).toBe(100);
    brainbaseApi([{ role: "assistant", content: '{"verdict": "Broken.", "score": -5}' }]);
    expect((await reviewSite(env, ARGS))?.score).toBe(0);
  });

  it("uses the last verdict when the agent revises itself", async () => {
    brainbaseApi([{ role: "assistant", content: '{"verdict": "Draft.", "score": 50} then {"verdict": "Final.", "score": 80}' }]);
    const review = await reviewSite(env, ARGS);
    expect(review?.verdict).toBe("Final.");
    expect(review?.score).toBe(80);
  });

  it("keeps an unscored verdict when score is null", async () => {
    brainbaseApi([{ role: "assistant", content: '{"verdict": "Could not load the preview: timeout.", "score": null}' }]);
    const review = await reviewSite(env, ARGS);
    expect(review?.verdict).toBe("Could not load the preview: timeout.");
    expect(review && "score" in review).toBe(false);
  });

  it("keeps the reviewer's plain words when there is no JSON", async () => {
    brainbaseApi([{ role: "assistant", content: "```\nLooks honest and clear.\n```" }]);
    const review = await reviewSite(env, ARGS);
    expect(review?.verdict).toBe("Looks honest and clear.");
    expect(review?.score).toBeUndefined();
  });

  it("returns null and explains why when the account is out of credits", async () => {
    const { calls } = brainbaseApi([], () => jsonResponse({ error: "payment required" }, 402));
    expect(await reviewSite(env, ARGS)).toBeNull();
    expect(brainbase.lastBrainbaseError).toMatch(/out of credits/);
    // 402 is a 4xx other than auth, so it retries once on the harness default model first.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("returns null without retrying when the key is rejected", async () => {
    const { calls } = brainbaseApi([], () => jsonResponse({ error: "unauthorized" }, 401));
    expect(await reviewSite(env, ARGS)).toBeNull();
    expect(brainbase.lastBrainbaseError).toBe("the Brainbase API key was rejected");
    expect(calls).toHaveLength(1);
  });

  it("never throws, even when the network fails", async () => {
    stubFetch(() => {
      throw new TypeError("network down");
    });
    await expect(reviewSite(env, ARGS)).resolves.toBeNull();
  });
});
