import { log } from "./log";
import type { RetryPolicy } from "./retry-policies";

export type RetryErrorKind = "transient" | "permanent" | "unknown";
export class RetryBudgetExhaustedError extends Error {
  constructor(readonly operation: string, readonly attempts: number, readonly elapsedMs: number,
    readonly lastError: unknown, readonly reason: "attempts" | "deadline" | "permanent",
    readonly startedAtMs: number) {
    super(`${operation} stopped after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${reason}`);
  }
}

export type Retryable<T> = Readonly<{
  operation: string;
  key: string;
  policy: RetryPolicy;
  run: (attempt: number) => Promise<T>;
  classifyError: (error: unknown, attempt: number) => RetryErrorKind;
  startedAtMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  random?: () => number;
  onBudgetExhausted?: (error: RetryBudgetExhaustedError) => void;
}>;

export function retryDelayMs(policy: RetryPolicy, attempt: number, random = Math.random): number {
  const base = Math.min(policy.capDelayMs, policy.baseDelayMs * 2 ** Math.min(32, Math.max(0, attempt - 1)));
  const factor = 1 + (Math.max(0, Math.min(1, random())) * 2 - 1) * policy.jitterFraction;
  return Math.max(0, Math.floor(base * factor));
}

export function nextRetry(input: { policy: RetryPolicy; attempt: number; startedAtMs: number; nowMs: number;
  classification: RetryErrorKind; retryAtMs?: number | null; random?: () => number }):
  { action: "retry"; atMs: number } | { action: "stop"; reason: "attempts" | "deadline" | "permanent" } {
  if (input.classification === "permanent") return { action: "stop", reason: "permanent" };
  if (input.attempt >= input.policy.maxAttempts) return { action: "stop", reason: "attempts" };
  if (input.nowMs - input.startedAtMs >= input.policy.maxAgeMs) return { action: "stop", reason: "deadline" };
  const atMs = input.retryAtMs ?? input.nowMs + retryDelayMs(input.policy, input.attempt, input.random);
  if (atMs - input.startedAtMs >= input.policy.maxAgeMs) return { action: "stop", reason: "deadline" };
  return { action: "retry", atMs };
}

export async function withRetry<T>(input: Retryable<T>): Promise<T> {
  if (!input.policy || !Number.isFinite(input.policy.maxAgeMs) || !Number.isFinite(input.policy.maxAttempts)) {
    throw new Error("A retry requires a finite named policy.");
  }
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const startedAtMs = input.startedAtMs ?? now();
  let lastError: unknown = null;
  const exhausted = (attempts: number, reason: RetryBudgetExhaustedError["reason"]): never => {
    const error = new RetryBudgetExhaustedError(input.operation, attempts, Math.max(0, now() - startedAtMs),
      lastError, reason, startedAtMs);
    log("error", "retry_budget_exhausted", { operation: input.operation, attempts, elapsed_ms: error.elapsedMs,
      reason, last_error: String(lastError) });
    input.onBudgetExhausted?.(error);
    throw error;
  };
  for (let attempt = 1; attempt <= input.policy.maxAttempts; attempt++) {
    if (now() - startedAtMs >= input.policy.maxAgeMs) exhausted(attempt - 1, "deadline");
    try { return await input.run(attempt); }
    catch (error) {
      lastError = error;
      const kind = input.classifyError(error, attempt);
      if (kind === "permanent") exhausted(attempt, "permanent");
      if (attempt >= input.policy.maxAttempts) exhausted(attempt, "attempts");
      const remaining = input.policy.maxAgeMs - (now() - startedAtMs);
      if (remaining <= 0) exhausted(attempt, "deadline");
      await wait(Math.min(remaining, retryDelayMs(input.policy, attempt, input.random)));
    }
  }
  return exhausted(input.policy.maxAttempts, "attempts");
}
