import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log";
import { toMrkdwn } from "./mrkdwn";

// Slack chat methods whose `text` arg is user-visible content that must be
// mrkdwn (bold=`*x*`, links=`<url|label>`, no `##` headers, no `---` rules).
// Any new chat.* method that renders a body belongs here.
const MRKDWN_METHODS = new Set([
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.update",
  "chat.scheduleMessage",
]);

function applyMrkdwn(method: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!MRKDWN_METHODS.has(method)) return args;
  const text = args.text;
  if (typeof text !== "string" || text.length === 0) return args;
  const converted = toMrkdwn(text);
  return converted === text ? args : { ...args, text: converted };
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity = 15,
    private readonly refillMs = 60_000,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async take() {
    for (;;) {
      this.refill();
      if (this.tokens > 0) {
        this.tokens -= 1;
        return;
      }
      await sleep(1000);
    }
  }

  reset() {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    if (now - this.lastRefill < this.refillMs) return;
    const periods = Math.floor((now - this.lastRefill) / this.refillMs);
    this.tokens = Math.min(this.capacity, this.tokens + periods * this.capacity);
    this.lastRefill += periods * this.refillMs;
  }
}

export const slackBucket = new TokenBucket(15, 60_000);
export const canvasSlackBucket = new TokenBucket(15, 60_000);
const slackListBuckets = new Map<string, TokenBucket>();

function slackMethod(client: any, method: string) {
  const parts = method.split(".");
  let target = client;
  for (const part of parts) {
    target = target?.[part];
  }
  if (typeof target !== "function") throw new Error(`Slack client method not found: ${method}`);
  const parent = parts.slice(0, -1).reduce((obj, part) => obj?.[part], client);
  return target.bind(parent);
}

function retryAfterSeconds(err: any): number | null {
  const retry = err?.data?.retry_after ?? err?.retryAfter ?? err?.headers?.["retry-after"];
  const parsed = Number(retry);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function rateLimitedSlackCall<T>(
  bucket: TokenBucket,
  client: any,
  method: string,
  args: Record<string, unknown>,
  context: { channel?: string; user?: string } = {},
): Promise<T> {
  const call = slackMethod(client, method);
  const outgoing = applyMrkdwn(method, args);
  await bucket.take();
  try {
    return assertSlackOk(await call(outgoing));
  } catch (err: any) {
    const retry = retryAfterSeconds(err);
    if (!retry) throw err;
    log("warn", "slack_rate_limited", { method, retry_after: retry, channel: context.channel });
    if (context.channel && context.user) {
      try {
        await client.chat.postEphemeral({
          channel: context.channel,
          user: context.user,
          text: `Slack rate-limited Concierge, retrying in ${retry}s.`,
        });
      } catch (warningErr) {
        log("warn", "slack_rate_limit_warning_failed", { method, error: String(warningErr) });
      }
    }
    await sleep(retry * 1000);
    await bucket.take();
    return assertSlackOk(await call(outgoing));
  }
}

export async function slackCall<T>(
  client: any,
  method: string,
  args: Record<string, unknown>,
  context: { channel?: string; user?: string } = {},
): Promise<T> {
  return await rateLimitedSlackCall(slackBucket, client, method, args, context);
}

export async function singleAttemptSlackCall<T>(
  client: any,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  const call = slackMethod(client, method);
  await slackBucket.take();
  return assertSlackOk(await call(applyMrkdwn(method, args)));
}

export async function canvasSlackCall<T>(
  client: any,
  method: string,
  args: Record<string, unknown>,
  context: { channel?: string; user?: string } = {},
): Promise<T> {
  return await rateLimitedSlackCall(canvasSlackBucket, client, method, args, context);
}

export async function slackListCall<T>(
  client: any,
  method: string,
  args: Record<string, unknown>,
  context: { channel?: string; user?: string } = {},
): Promise<T> {
  let bucket = slackListBuckets.get(method);
  if (!bucket) {
    bucket = new TokenBucket(20, 60_000);
    slackListBuckets.set(method, bucket);
  }
  return await rateLimitedSlackCall(bucket, client, method, args, context);
}

export function resetSlackListBucketsForTests() {
  slackListBuckets.clear();
}

function assertSlackOk<T>(result: T): T {
  if ((result as any)?.ok === false) {
    const err: any = new Error(String((result as any).error || "slack_api_error"));
    err.data = result;
    throw err;
  }
  return result;
}
