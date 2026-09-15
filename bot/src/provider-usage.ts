import { db } from "./state";
import { log } from "./log";
import { ProviderDispatchError } from "./provider-failures";
import { canonicalClaudeUsageModel } from "./aliases";

export type UsageProvider = "codex" | "claude-code";
type UsageLimit = { resetAt: number | null; observedAt: number; revision: number };
type UsageState = { generation: number; revision: number; limits: Record<string, UsageLimit> };
export type UsageAttempt = { provider: UsageProvider; scope: string; generation: number; revision: number };

function read(provider: UsageProvider): UsageState {
  const row = db.query("SELECT generation, revision, limits_json FROM provider_usage_cache WHERE provider = ?")
    .get(provider) as { generation: number; revision: number; limits_json: string } | null;
  return row ? { generation: row.generation, revision: row.revision, limits: JSON.parse(row.limits_json) }
    : { generation: 0, revision: 0, limits: {} };
}

function write(provider: UsageProvider, state: UsageState) {
  db.query(`INSERT INTO provider_usage_cache (provider, generation, revision, limits_json)
    VALUES (?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET
    generation = excluded.generation, revision = excluded.revision, limits_json = excluded.limits_json`)
    .run(provider, state.generation, state.revision, JSON.stringify(state.limits));
}

function prune(state: UsageState, now = Date.now()) {
  for (const [scope, limit] of Object.entries(state.limits)) {
    if (limit.resetAt !== null && limit.resetAt <= now) delete state.limits[scope];
  }
}

export function usageAttempt(provider: UsageProvider, model?: string): UsageAttempt {
  if (provider === "claude-code" && !model?.trim()) throw new Error("Claude usage scope requires an exact model.");
  const state = read(provider);
  return { provider, scope: provider === "codex" ? "account" : canonicalClaudeUsageModel(model!.trim()),
    generation: state.generation, revision: state.revision };
}

export function cachedUsageLimit(attempt: UsageAttempt): UsageLimit | null {
  const state = read(attempt.provider);
  if (state.generation !== attempt.generation) return null;
  const limit = state.limits[attempt.scope];
  return limit?.resetAt != null && limit.resetAt > Date.now() ? limit : null;
}

export function usageLimitMessage(attempt: UsageAttempt, limit: UsageLimit): string {
  return `${attempt.provider === "codex" ? "Codex account" : attempt.scope} usage is cached as exhausted until ${new Date(limit.resetAt!).toISOString()}. `
    + `No request was sent to this ${attempt.provider === "codex" ? "account" : "model"}. After a top-up or early reset, clear it with provider-usage.ts clear ${attempt.provider}.`;
}

export function assertUsageAvailable(attempt: UsageAttempt) {
  const limit = cachedUsageLimit(attempt);
  if (!limit) return;
  log("info", "provider_usage_cached_refusal", { provider: attempt.provider, scope: attempt.scope, reset_at: limit.resetAt });
  throw new ProviderDispatchError({ message: usageLimitMessage(attempt, limit),
    failureClass: "parked_terminal", terminalConfirmed: true });
}

export function recordUsageExhaustion(attempt: UsageAttempt, resetAt: number | null) {
  persistUsageObservation(attempt, () => db.transaction(() => {
    const state = read(attempt.provider);
    if (state.generation !== attempt.generation) return false;
    prune(state);
    const validReset = resetAt !== null && Number.isSafeInteger(resetAt) && resetAt > Date.now() ? resetAt : null;
    state.limits[attempt.scope] = { resetAt: validReset ?? state.limits[attempt.scope]?.resetAt ?? null,
      observedAt: Date.now(), revision: ++state.revision };
    write(attempt.provider, state);
    const retainedReset = state.limits[attempt.scope]!.resetAt;
    log("info", "provider_usage_exhausted", { provider: attempt.provider,
      scope: attempt.scope, reset_at: retainedReset, reset_known: retainedReset !== null });
  }).immediate());
}

export function recordUsageSuccess(attempt: UsageAttempt) {
  persistUsageObservation(attempt, () => db.transaction(() => {
    const state = read(attempt.provider);
    const limit = state.limits[attempt.scope];
    // An older success cannot erase a quota failure observed after it started.
    if (state.generation !== attempt.generation || !limit || limit.revision > attempt.revision) return;
    delete state.limits[attempt.scope];
    prune(state);
    write(attempt.provider, state);
  }).immediate());
}

function persistUsageObservation(attempt: UsageAttempt, effect: () => unknown) {
  try { effect(); }
  catch {
    // Cache persistence cannot turn completed provider effects into a retryable failure.
    log("warn", "provider_usage_cache_write_failed", { provider: attempt.provider, scope: attempt.scope });
  }
}

export function clearProviderUsage(provider: UsageProvider) {
  const generation = db.transaction(() => {
    const state = read(provider);
    // In-flight attempts belong to the old generation and cannot restore stale limits.
    state.generation++;
    state.revision++;
    state.limits = {};
    write(provider, state);
    return state.generation;
  }).immediate();
  log("info", "provider_usage_cleared", { provider, generation });
  return { provider, generation, cleared: true, resumed_work: false };
}

export function providerUsageStatus() {
  return (["codex", "claude-code"] as const).map(provider => {
    const state = read(provider);
    return { provider, generation: state.generation, limits: Object.entries(state.limits).map(([scope, limit]) => ({
      scope, observed_at: new Date(limit.observedAt).toISOString(),
      reset_at: limit.resetAt === null ? null : new Date(limit.resetAt).toISOString(),
      blocking: limit.resetAt !== null && limit.resetAt > Date.now(),
    })) };
  });
}

export function resetEpochMilliseconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const milliseconds = value * 1_000;
  return Number.isSafeInteger(milliseconds) && milliseconds <= 8.64e15 ? milliseconds : null;
}

/** A rejected turn proves exhaustion; percentages alone do not prove dispatch is forbidden. */
export function codexUsageReset(snapshot: any): number | null {
  if (!snapshot || (snapshot.limitId != null && snapshot.limitId !== "codex")
    || (snapshot.limit_id != null && snapshot.limit_id !== "codex")) return null;
  const resets = [snapshot.primary, snapshot.secondary].flatMap(window => {
    const used = window?.usedPercent ?? window?.used_percent;
    const reset = resetEpochMilliseconds(window?.resetsAt ?? window?.resets_at);
    return typeof used === "number" && used >= 100 && reset !== null && reset > Date.now() ? [reset] : [];
  });
  return resets.length ? Math.max(...resets) : null;
}
