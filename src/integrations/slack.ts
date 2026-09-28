// Slack incoming-webhook notifier. Mirrors the notable moments of the agent channel
// (sites going live, replies, money) into a real Slack channel.
//
// Contract: notifySlack(env, text) is a no-op without SLACK_WEBHOOK_URL and never throws.
// Calls are serialized with ~1s spacing because Slack rate-limits incoming webhooks to
// roughly one message per second per channel.

import type { Env } from "../types";

const TIMEOUT_MS = 5000;
const SPACING_MS = 1000;

let chain: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(url: string, text: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // Drain the body so the connection can be reused; log without leaking the URL.
      const body = await res.text().catch(() => "");
      console.warn(`slack webhook responded ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`slack webhook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function slackEnabled(env: Env): boolean {
  const url = env.SLACK_WEBHOOK_URL?.trim();
  return !!url && url.startsWith("https://");
}

/** Escape the three characters Slack's mrkdwn treats as control characters. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Slack mrkdwn link: <url|label>. */
export function slackLink(url: string, label: string): string {
  return `<${url.replace(/[<>|]/g, "")}|${slackEscape(label).replace(/\|/g, "/")}>`;
}

export function notifySlack(env: Env, text: string): Promise<void> {
  try {
    if (!slackEnabled(env) || !text) return Promise.resolve();
    const url = env.SLACK_WEBHOOK_URL!.trim();
    const clipped = text.length > 3500 ? `${text.slice(0, 3490)}…` : text;
    const run = chain.then(() => post(url, clipped));
    chain = run.then(() => sleep(SPACING_MS)).catch(() => undefined);
    return run.catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}
