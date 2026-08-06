import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log";

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

  private refill() {
    const now = Date.now();
    if (now - this.lastRefill < this.refillMs) return;
    const periods = Math.floor((now - this.lastRefill) / this.refillMs);
    this.tokens = Math.min(this.capacity, this.tokens + periods * this.capacity);
    this.lastRefill += periods * this.refillMs;
  }
}

export const slackBucket = new TokenBucket(15, 60_000);

function retryAfterSeconds(err: any): number | null {
  const retry = err?.data?.retry_after ?? err?.retryAfter ?? err?.headers?.["retry-after"];
  const parsed = Number(retry);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function slackCall<T>(
  client: any,
  method: string,
  args: Record<string, unknown>,
  context: { channel?: string; user?: string } = {},
): Promise<T> {
  const [group, fn] = method.split(".");
  const call = client[group][fn].bind(client[group]);
  await slackBucket.take();
  try {
    return await call(args);
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
    await slackBucket.take();
    return await call(args);
  }
}
