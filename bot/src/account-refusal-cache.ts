/**
 * The one store for cached refusals. One row per (provider, account, model) triple;
 * every reader and writer in the codebase routes through this module.
 *
 * Why this module exists separately from `provider-usage.ts`: before 2026-11-19,
 * `provider-usage.ts` carried a `claudeAccountCachedReset(account, model?)`
 * primitive whose dual role — model-specific lookup vs. model-agnostic max —
 * meant one model's refusal poisoned another's dispatch (fault F1 of
 * `docs/incidents/2026-11-19-opus-only-refusal-blocked-every-claude-turn.md`).
 * The clean split: this module answers "is THIS model refused on THIS account?",
 * and the higher-level `account-authority.ts` composes those answers across
 * allowance models.
 *
 * Preserved dated reasons:
 *   - "Codex limit outlived account identity" (`provider-accounts.ts:16-20`,
 *     2026-09-15) → `scopeKey` always carries account identity; a Codex limit
 *     written with no account scope cannot be read back.
 *   - "A later exact-account reset supersedes an older in-flight failure"
 *     (`provider-usage.ts:112-113`) → `recordRefusal` compares revisions
 *     before overwriting.
 *   - "An older success cannot erase a quota failure observed after it started"
 *     (`provider-usage.ts:128-129`) → `retireRefusalBySuccess` compares
 *     observedAt against the refusal's observedAt.
 *   - "The Nov 3 refusal held every Codex turn while the account read 7%"
 *     (`provider-usage.ts:184-187`, 2026-11-06) → `retireRefusalSupersededByReading`
 *     is generic and applies to Claude too, fixing F2.
 */

import { createHash } from "node:crypto";
import { db, releaseScheduledProviderRetries } from "./state";
import { usageCacheTable } from "./provider-usage-tables";
import { claudeUsageAllowanceModel, CLAUDE_USAGE_FALLBACK_CHAIN } from "./aliases";
import { log } from "./log";

export type RefusalProvider = "codex" | "claude-code" | "antigravity";

export type RefusalRecord = Readonly<{
  provider: RefusalProvider;
  accountLabel: string;
  model: string | null;       // null only for Codex (account-wide refusals)
  scope: string;              // the storage key used internally
  resetAtMs: number | null;
  observedAtMs: number;
  generation: number;
  revision: number;
}>;

export type RefusalWriteToken = Readonly<{
  provider: RefusalProvider;
  scope: string;
  accountLabel: string;
  model: string | null;
  generation: number;
  revision: number;
}>;

type StoredLimit = { resetAt: number | null; observedAt: number; revision: number };
type CacheState = { generation: number; revision: number; limits: Record<string, StoredLimit> };

function readState(provider: RefusalProvider): CacheState {
  const row = db.query(
    `SELECT generation, revision, limits_json FROM ${usageCacheTable(provider)} WHERE provider = ?`
  ).get(provider) as { generation: number; revision: number; limits_json: string } | null;
  return row
    ? { generation: row.generation, revision: row.revision, limits: JSON.parse(row.limits_json) }
    : { generation: 0, revision: 0, limits: {} };
}

function writeState(provider: RefusalProvider, state: CacheState): void {
  db.query(
    `INSERT INTO ${usageCacheTable(provider)} (provider, generation, revision, limits_json)
     VALUES (?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET
       generation = excluded.generation, revision = excluded.revision, limits_json = excluded.limits_json`
  ).run(provider, state.generation, state.revision, JSON.stringify(state.limits));
}

/** Prune entries whose reset has passed. Called on reads so the common case is lazy. */
function pruneExpired(state: CacheState, now: number): boolean {
  let changed = false;
  for (const [scope, limit] of Object.entries(state.limits)) {
    if (limit.resetAt !== null && limit.resetAt <= now) {
      delete state.limits[scope];
      changed = true;
    }
  }
  return changed;
}

/** `sha256(label.toLowerCase())[:24]` — the account identity component of every scope. */
export function accountHash(label: string): string {
  return createHash("sha256").update(label.toLowerCase()).digest("hex").slice(0, 24);
}

/**
 * The scope key format:
 *   - Claude: `<accountHash>:<canonicalAllowanceModel>` (Opus 1M collapses to Opus).
 *   - Codex:  `<account_id>` or `<accountHash>` when the account_id is not known.
 *   - Antigravity: `<accountHash>:<model>` (never Opus-collapsed).
 */
export function scopeKey(provider: RefusalProvider, accountLabel: string, model: string | null, codexAccountId?: string | null): string {
  if (provider === "codex") {
    return (codexAccountId ?? "").trim() || accountHash(accountLabel);
  }
  if (provider === "antigravity") {
    if (!model?.trim()) throw new Error("Antigravity refusal requires a model.");
    return `${accountHash(accountLabel)}:${model.trim()}`;
  }
  // Claude: must have a model; collapse Opus-1M to Opus.
  if (!model?.trim()) throw new Error("Claude refusal requires a model (did you mean `cachedRefusalsForAccount`?).");
  return `${accountHash(accountLabel)}:${claudeUsageAllowanceModel(model.trim())}`;
}

/**
 * Begin a write that will be committed with `recordRefusal`/`retireRefusalBySuccess`.
 * The returned token captures the current generation and revision so a concurrent
 * `clearAll(provider)` can invalidate the in-flight attempt.
 */
export function openWrite(provider: RefusalProvider, accountLabel: string, model: string | null, codexAccountId?: string | null): RefusalWriteToken {
  const state = readState(provider);
  return {
    provider,
    scope: scopeKey(provider, accountLabel, model, codexAccountId),
    accountLabel,
    model,
    generation: state.generation,
    revision: state.revision,
  };
}

/** Record a 429 refusal. Preserves generation/revision checks. */
export function recordRefusal(token: RefusalWriteToken, resetAtMs: number | null, now: number = Date.now()): boolean {
  let committed = false;
  try {
    db.transaction(() => {
      const state = readState(token.provider);
      if (state.generation !== token.generation) return;        // operator cleared since open
      pruneExpired(state, now);
      const existing = state.limits[token.scope];
      if ((existing?.revision ?? -1) > token.revision) return;  // another writer already won
      const validReset = resetAtMs !== null && Number.isSafeInteger(resetAtMs) && resetAtMs > now ? resetAtMs : null;
      state.limits[token.scope] = {
        resetAt: validReset ?? existing?.resetAt ?? null,
        observedAt: now,
        revision: ++state.revision,
      };
      writeState(token.provider, state);
      committed = true;
    }).immediate();
  } catch {
    log("warn", "provider_usage_cache_write_failed", { provider: token.provider, scope: token.scope });
  }
  if (committed) {
    log("info", "provider_usage_exhausted", {
      provider: token.provider, scope: token.scope,
      reset_at: resetAtMs, reset_known: resetAtMs !== null,
    });
  }
  return committed;
}

/** Record a successful turn. Removes the refusal if its revision is at or below the token's. */
export function retireRefusalBySuccess(token: RefusalWriteToken): boolean {
  let retired = false;
  try {
    db.transaction(() => {
      const state = readState(token.provider);
      const limit = state.limits[token.scope];
      if (state.generation !== token.generation || !limit || limit.revision > token.revision) return;
      delete state.limits[token.scope];
      pruneExpired(state, Date.now());
      writeState(token.provider, state);
      retired = true;
    }).immediate();
  } catch {
    log("warn", "provider_usage_cache_write_failed", { provider: token.provider, scope: token.scope });
  }
  return retired;
}

/** Read the refusal for a single (account, model) pair, or null if no active refusal. */
export function cachedRefusal(
  provider: RefusalProvider,
  accountLabel: string,
  model: string | null,
  codexAccountId?: string | null,
  now: number = Date.now(),
): RefusalRecord | null {
  if (provider !== "codex" && !model?.trim()) return null;
  const state = readState(provider);
  const scope = scopeKey(provider, accountLabel, model, codexAccountId);
  const limit = state.limits[scope];
  if (!limit || limit.resetAt === null || limit.resetAt <= now) return null;
  return {
    provider, accountLabel, model, scope,
    resetAtMs: limit.resetAt, observedAtMs: limit.observedAt,
    generation: state.generation, revision: limit.revision,
  };
}

/** Every refusal under one account. Used by the model-agnostic "any work" question. */
export function cachedRefusalsForAccount(
  provider: RefusalProvider,
  accountLabel: string,
  now: number = Date.now(),
): RefusalRecord[] {
  const state = readState(provider);
  const prefix = accountHash(accountLabel);
  const records: RefusalRecord[] = [];
  for (const [scope, limit] of Object.entries(state.limits)) {
    if (!scope.startsWith(prefix)) continue;
    if (limit.resetAt === null || limit.resetAt <= now) continue;
    const model = provider === "codex" ? null : scope.slice(prefix.length + 1) || null;
    records.push({
      provider, accountLabel, model, scope,
      resetAtMs: limit.resetAt, observedAtMs: limit.observedAt,
      generation: state.generation, revision: limit.revision,
    });
  }
  return records;
}

/**
 * The clearsAt an account would clear by if every Claude allowance model is refused.
 * Returns null if any allowance model has no cached refusal (that model has room).
 *
 * This is the F1 fix: the model-agnostic question goes through here instead of
 * `claudeAccountCachedReset(account, null)`, which returned the max across all
 * cached models and let Opus poison Sonnet/Haiku.
 */
export function anyWorkCachedReset(accountLabel: string, now: number = Date.now()): number | null {
  const records = cachedRefusalsForAccount("claude-code", accountLabel, now);
  const byModel = new Map<string, RefusalRecord>();
  for (const record of records) {
    if (record.model) byModel.set(record.model, record);
  }
  const resets: number[] = [];
  for (const model of CLAUDE_USAGE_FALLBACK_CHAIN) {
    const allowanceModel = claudeUsageAllowanceModel(model);
    const record = byModel.get(allowanceModel);
    if (!record) return null;  // this model has room → any-work has room
    if (record.resetAtMs !== null) resets.push(record.resetAtMs);
  }
  return resets.length ? Math.max(...resets) : null;
}

/**
 * Generic retire-by-reading rule.
 *
 * A fresh reading for an account with every included window under 100% AND no
 * window whose reset matches the cached refusal's reset within 60 seconds is
 * evidence that the window that caused the refusal has been replaced (a reset
 * spent elsewhere, or the window has turned over naturally). This applied to
 * Codex at `provider-usage.ts:188-199` as of 2026-11-06; applying it to Claude
 * closes fault F2.
 *
 * `model` identifies which allowance window the reading is being compared against.
 * For Codex, pass `null` (account-wide).
 */
export function retireRefusalSupersededByReading(
  provider: RefusalProvider,
  accountLabel: string,
  model: string | null,
  windows: ReadonlyArray<{ usedPercent: number | null; resetsAt: string | null }>,
  readAtMs: number,
  codexAccountId?: string | null,
): boolean {
  if (!windows.length) return false;
  if (windows.some(w => w.usedPercent === null || w.usedPercent >= 100 || !w.resetsAt)) return false;
  const scope = scopeKey(provider, accountLabel, model, codexAccountId);
  let retired = false;
  try {
    db.transaction(() => {
      const state = readState(provider);
      const limit = state.limits[scope];
      if (!limit || limit.resetAt === null || limit.observedAt >= readAtMs) return;
      const refusedReset = limit.resetAt;
      if (windows.some(w => Math.abs(Date.parse(w.resetsAt!) - refusedReset) < 60_000)) return;
      delete state.limits[scope];
      state.revision++;
      writeState(provider, state);
      retired = true;
    }).immediate();
  } catch {
    log("warn", "provider_usage_cache_write_failed", { provider, scope });
  }
  if (retired) {
    log("info", "provider_cache_superseded_by_reading", {
      provider, scope, read_at: new Date(readAtMs).toISOString(),
    });
  }
  return retired;
}

/** Scoped clear: all / one account / one (account, model). Returns rows cleared. */
export function clearScoped(provider: RefusalProvider, accountLabel?: string | null, model?: string | null, codexAccountId?: string | null): { cleared: number; generation: number } {
  if (!accountLabel && !model) return clearAll(provider);
  if (!accountLabel) {
    throw new Error("clearScoped requires an account label when a model is provided.");
  }
  const scope = model ? scopeKey(provider, accountLabel, model, codexAccountId) : null;
  const prefix = accountHash(accountLabel);
  let cleared = 0;
  const result = db.transaction(() => {
    const state = readState(provider);
    for (const existingScope of Object.keys(state.limits)) {
      const match = scope ? existingScope === scope : existingScope.startsWith(prefix);
      if (match) {
        delete state.limits[existingScope];
        cleared++;
      }
    }
    state.revision++;
    writeState(provider, state);
    return { cleared, generation: state.generation };
  }).immediate();
  log("info", "provider_usage_cleared_scoped", { provider, account: accountLabel, model, cleared: result.cleared });
  if (result.cleared > 0) releaseScheduledProviderRetries(provider);
  return result;
}

/** Nuke every refusal for the provider. Bumps generation so in-flight writes are invalidated. */
export function clearAll(provider: RefusalProvider): { cleared: number; generation: number } {
  const result = db.transaction(() => {
    const state = readState(provider);
    const cleared = Object.keys(state.limits).length;
    state.generation++;
    state.revision++;
    state.limits = {};
    writeState(provider, state);
    return { cleared, generation: state.generation };
  }).immediate();
  log("info", "provider_usage_cleared", { provider, generation: result.generation, released: result.cleared });
  releaseScheduledProviderRetries(provider);
  return result;
}
