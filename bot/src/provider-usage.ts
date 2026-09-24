import { db, releaseScheduledProviderRetries } from "./state";
import {createHash} from 'node:crypto';
import { log } from "./log";
import { ProviderDispatchError } from "./provider-failures";
import { canonicalClaudeUsageModel } from "./aliases";
import { accountScope, currentAccount } from "./provider-accounts";

export type UsageProvider = "codex" | "claude-code";
type UsageLimit = { resetAt: number | null; observedAt: number; revision: number };
type UsageState = { generation: number; revision: number; limits: Record<string, UsageLimit> };
export type UsageAttempt = { provider: UsageProvider; scope: string; label: string; generation: number; revision: number };

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

// A usage limit belongs to the account that earned it. Naming that account in
// the scope is what stops a new account from inheriting the previous account's
// exhaustion: its scope simply does not match the recorded limit. Codex
// previously used the literal scope "account", which carried no identity, so a
// limit outlived the account it belonged to and refused every dispatch locally
// until an operator remembered `provider-usage.ts clear codex`.
export function usageScope(provider: UsageProvider, model?: string): string {
  const account = accountScope(provider);
  return provider === "codex" ? account : `${account}:${canonicalClaudeUsageModel(model!.trim())}`;
}

export function usageAttempt(provider: UsageProvider, model?: string, selectedAccount?:string): UsageAttempt {
  if (provider === "claude-code" && !model?.trim()) throw new Error("Claude usage scope requires an exact model.");
  const state = read(provider);
  const account = currentAccount(provider);
  const accountKey=selectedAccount?createHash('sha256').update(selectedAccount.toLowerCase()).digest('hex').slice(0,24):null;
  const scope=provider==='codex'&&selectedAccount&&selectedAccount!==account?.label?`account:${accountKey}`
    :accountKey&&provider==='claude-code'?`${accountKey}:${canonicalClaudeUsageModel(model!.trim())}`:usageScope(provider, model);
  return { provider, scope,
    // What a person should be told the limit applies to. The scope carries a
    // credential fingerprint and never belongs in a message.
    label: provider === "codex" ? selectedAccount??account?.label ?? "this Codex account"
      : `${canonicalClaudeUsageModel(model!.trim())} on ${selectedAccount??account?.label ?? "this Claude account"}`,
    generation: state.generation, revision: state.revision };
}

export function cachedUsageLimit(attempt: UsageAttempt): UsageLimit | null {
  const state = read(attempt.provider);
  if (state.generation !== attempt.generation) return null;
  const limit = state.limits[attempt.scope];
  return limit?.resetAt != null && limit.resetAt > Date.now() ? limit : null;
}

/** A refusal from this account's attempted Claude model survives a process restart. */
export function claudeAccountCachedReset(account:string):number|null {
  const prefix=`${createHash('sha256').update(account.toLowerCase()).digest('hex').slice(0,24)}:`;
  const state=read('claude-code');
  const resets=Object.entries(state.limits).filter(([scope,limit])=>scope.startsWith(prefix)&&limit.resetAt!==null&&limit.resetAt>Date.now())
    .map(([,limit])=>limit.resetAt!);
  return resets.length?Math.max(...resets):null;
}

export function usageLimitMessage(attempt: UsageAttempt, limit: UsageLimit): string {
  // The limit is recorded against this account, so signing into a different one
  // in Provider accounts lifts it immediately. No cache command is involved.
  return `Usage for ${attempt.label} is cached as exhausted until ${new Date(limit.resetAt!).toISOString()}. `
    + "No request was sent, so this input keeps its place and is tried again at that time. "
    + "Switching to another account in Provider accounts starts sending again sooner.";
}

/**
 * Refuses before sending, and says when the refusal clears. `clearsAtMs` is what keeps the
 * input alive: nothing left this machine, so there is no uncertain provider effect to
 * protect, and the turn waits in its own queue instead of being killed. Until 2026-09-23
 * this threw a plain terminal failure, and a five-hour Claude limit silently destroyed
 * nine of the Inbox's inputs — including the returns that were reporting the outage.
 */
export function assertUsageAvailable(attempt: UsageAttempt) {
  const limit = cachedUsageLimit(attempt);
  if (!limit) return;
  log("info", "provider_usage_cached_refusal", { provider: attempt.provider, scope: attempt.scope, reset_at: limit.resetAt });
  throw new ProviderDispatchError({ message: usageLimitMessage(attempt, limit),
    failureClass: "parked_terminal", terminalConfirmed: true, clearsAtMs: limit.resetAt });
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
  const cleared = db.transaction(() => {
    const state = read(provider);
    // In-flight attempts belong to the old generation and cannot restore stale limits.
    state.generation++;
    state.revision++;
    state.limits = {};
    write(provider, state);
    // Work waiting for this provider's allowance to reset is waiting for a reason that no
    // longer applies, so its scheduled instant moves to now. Nothing is replayed: only a
    // queued input's own next attempt time changes, and stopped, paused and archived work
    // is untouched.
    return { generation: state.generation, released: releaseScheduledProviderRetries(provider) };
  }).immediate();
  log("info", "provider_usage_cleared", { provider, generation: cleared.generation, released: cleared.released });
  return { provider, generation: cleared.generation, cleared: true, resumed_work: cleared.released > 0 };
}

/**
 * The allowance that was blocking work belongs to the account that earned it, so
 * activating a different account releases anything waiting on the old one's reset.
 * Called where a credential change becomes effective; it schedules, it does not replay.
 */
export function releaseUsageHeldWork(provider: UsageProvider): number {
  const released = releaseScheduledProviderRetries(provider);
  if (released > 0) log("info", "provider_usage_hold_released", { provider, released });
  return released;
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
