/**
 * The one authority: `canTakeWork(provider, account, model, now) → CapabilityVerdict`.
 *
 * Before 2026-11-19 the question "can this account take this model's work right now?"
 * was answered by at least twelve independent places, each with its own refresh cadence
 * and interpretation. They disagreed, and on 2026-11-19 the disagreement became visible:
 * the Accounts page showed "Opus room remains · 39% weekly used" while the dispatcher
 * said "no account has room until Nov 22", and every Claude turn refused.
 *
 * This module collapses the twelve into one. Every current caller — dispatch, release,
 * cross-provider failover, UI badge, status commands — reads a verdict from here.
 *
 * Preserved dated reasons (incident → test file):
 *   - 2026-09-15 Codex limit scope (per-account, not per-provider) → `incidents/2026-09-15-codex-usage-limit-scope.test.ts`
 *   - 2026-09-22 silent-stop (refused work keeps its place) → Step 3 returns `clearsAtMs`
 *   - 2026-10-07 hand `/login` displaced personal account → resolver dedupes by label
 *   - 2026-10-09 every-account reset floor → per-account `clearsAtMs` in verdict
 *   - 2026-10-10 proven-attempt override → Step 5
 *   - 2026-10-15 stale reading hid 19% account → Step 6 (last-showed-room)
 *   - 2026-10-30 Ultra 5-hour removal → `includedAllowanceWindows` tolerance
 *   - 2026-11-02 Mac signin-wait read as usage → Step 1 returns `no-home`
 *   - 2026-11-02 Opus 1M shares Opus allowance → `claudeUsageAllowanceModel` collapse
 *   - 2026-11-03 Inbox held 35 min after new account → sign-in activation releases
 *   - 2026-11-06 Codex retire-by-reading rule → Step 3 applies generically
 *   - 2026-11-13 expired access token read as signed-out → Step 1 checks refresh token
 *   - 2026-11-15 warm cache kept spending → ranker warm-stay-band
 *   - 2026-11-16 aggregated room per provider → `providerRoomBreakdown`
 *   - 2026-11-19 F1/F2/F3/F4 — this module is the F1/F2 fix; §4/§6 cover F3/F4
 *
 * See `docs/plans/2026-11-19-provider-account-rebuild-architecture.md` §3 for the
 * full algorithm specification.
 */

import type { AccountUsage, ProviderUsage } from "./provider-account-usage";
import { providerAccountUsage } from "./provider-account-usage";
import {
  accountCanTakeWork,
  accountReadingAt,
  accountReadingFresh,
  codexCreditsCanCover,
  hasActiveFullAllowanceWindow,
  includedAllowanceWindows,
  ACCOUNT_READING_MAX_AGE_MS,
} from "./account-allowance-observation";
import { claudeUsageAllowanceModel, CLAUDE_USAGE_FALLBACK_CHAIN } from "./aliases";
import {
  listAccounts as listHomeAccounts,
  resolveAccountHome,
  type HomeRecord,
  type ResolverProvider,
} from "./account-home-resolver";
import {
  anyWorkCachedReset,
  cachedRefusal,
  cachedRefusalsForAccount,
  retireRefusalSupersededByReading,
  type RefusalProvider,
  type RefusalRecord,
} from "./account-refusal-cache";
import { claudeHomeProven, claudeHomeSignedOut } from "./provider-account-selection";
import { codexAccountIdForLabel } from "./provider-accounts";
import { db } from "./state";
import { log } from "./log";

/** One week — a reading older than this is treated as "stale but maybe-useful if positive". */
export const ACCOUNT_READING_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Home-proof window used by the "proven-attempt" override. */
export const HOME_PROOF_WINDOW_MS = 10 * 60 * 1000;

export type ProviderId = "claude-code" | "codex" | "antigravity";

export type AccountRef = Readonly<{
  provider: ProviderId;
  label: string;
}>;

export type CapabilityReason =
  | "ready"
  | "no-home"
  | "signed-out"
  | "cached-refusal"
  | "reading-exhausted"
  | "reading-stale"
  | "proven-attempt"
  | "last-showed-room"
  | "unknown";

export type CapabilityEvidence = Readonly<{
  home?: string;
  liveRootMirror?: boolean;
  signedIn?: boolean;
  readingReadAtMs?: number;
  readingFresh?: boolean;
  readingUsedPercent?: number | null;
  refusalScope?: string;
  refusalResetAtMs?: number | null;
  refusalObservedAtMs?: number;
  homeProvenAtMs?: number;
  conflict?: string;
  /** Anthropic's `rate_limit_event.overageDisabledReason`, normalized, when the cache's
   *  underlying refusal carried one. Different operator responses for different reasons:
   *  `out_of_credits` → buy more; `org_level_disabled` → enable overage. */
  overageReason?: 'out_of_credits' | 'org_level_disabled' | 'hard_limit_reached' | 'other' | null;
  /** The provider's rate_limit_type on the cached refusal ("seven_day", "five_hour", …). */
  rateLimitType?: string | null;
}>;

export type CapabilityVerdict = Readonly<{
  ok: boolean;
  reason: CapabilityReason;
  clearsAtMs: number | null;
  why: string;
  source: CapabilityEvidence;
  /** Short UI badge token: `ready` | `refused` | `signed-out` | `stale` | `unknown`.
   *  Derived from `reason` so UI readers don't branch on reason enum. */
  badge?: 'ready' | 'refused' | 'signed-out' | 'stale' | 'unknown';
  /** Human-readable short text for the UI, in product language (no code identifiers). */
  explain?: string;
}>;

function makeVerdict(ok: boolean, reason: CapabilityReason, clearsAtMs: number | null, why: string, source: CapabilityEvidence): CapabilityVerdict {
  return { ok, reason, clearsAtMs, why, source, badge: badgeFor(reason), explain: explainFor(reason, source, clearsAtMs) };
}

/** Maps the authority's `reason` to a stable UI badge token. */
function badgeFor(reason: CapabilityReason): 'ready' | 'refused' | 'signed-out' | 'stale' | 'unknown' {
  if (reason === 'ready' || reason === 'proven-attempt' || reason === 'last-showed-room') return 'ready';
  if (reason === 'signed-out' || reason === 'no-home') return 'signed-out';
  if (reason === 'cached-refusal' || reason === 'reading-exhausted') return 'refused';
  if (reason === 'reading-stale') return 'stale';
  return 'unknown';
}

/** Product-language short explanation for the UI. No code identifiers. */
function explainFor(reason: CapabilityReason, source: CapabilityEvidence, clearsAtMs: number | null): string {
  if (reason === 'ready') return `has room (${source.readingUsedPercent ?? 0}% used)`;
  if (reason === 'last-showed-room') return `last reading showed room (${source.readingUsedPercent ?? 0}% used)`;
  if (reason === 'proven-attempt') return 'recently proved by a successful turn';
  if (reason === 'signed-out') return 'needs sign-in on this machine';
  if (reason === 'no-home') return 'not set up on this machine';
  if (reason === 'cached-refusal') {
    const overage = source.overageReason;
    if (overage === 'out_of_credits') return 'out of paid credits';
    if (overage === 'org_level_disabled') return 'org disabled overage';
    if (overage === 'hard_limit_reached') return 'hit billing hard cap';
    return clearsAtMs ? `refused until ${new Date(clearsAtMs).toISOString()}` : 'refused';
  }
  if (reason === 'reading-exhausted') return clearsAtMs ? `fully used until ${new Date(clearsAtMs).toISOString()}` : 'fully used';
  if (reason === 'reading-stale') return 'last reading too old';
  return 'not readable';
}

/**
 * The one authority. Answers "can `provider`'s `account` take work using `model` right now?"
 *
 * Deterministic: no side effects except cache-retirement logging and the retire-by-reading
 * write (Step 3). Safe to call from any read path; always returns a verdict.
 */
export function canTakeWork(
  provider: ProviderId,
  account: AccountRef,
  model: string,
  now: number = Date.now(),
): CapabilityVerdict {
  if (!model?.trim()) {
    return makeVerdict(false, "unknown", null, "no model specified", {});
  }
  const providerKey = provider;
  const label = account.label;

  // Step 0 — Resolve the home. (Antigravity has no on-disk home; treat it as resolved.)
  const home = provider === "antigravity"
    ? ({ kind: "resolved" as const, provider: "codex" as ResolverProvider, path: null as string | null, liveRootMirror: false })
    : resolveHomeFor(provider, label);

  if (home.kind === "none") {
    return makeVerdict(false, "no-home", null, "no runnable home on this machine", {});
  }
  if (home.kind === "new-account-in-live-root") {
    return makeVerdict(false, "no-home", null,
      "live-root sign-in; run `accounts adopt-live-root` to migrate",
      { home: home.path ?? undefined, liveRootMirror: true });
  }

  const homePath = home.path ?? undefined;
  const liveRootMirror = home.liveRootMirror;

  // Step 1 — Credential state. For Claude we also consult the per-home proof table
  // which records "the credential refused" independently of filesystem presence.
  if (provider === "claude-code" && homePath !== undefined) {
    if (claudeHomeSignedOut(homePath)) {
      return makeVerdict(false, "signed-out", null,
        "Claude home proof says signed out",
        { home: homePath, liveRootMirror, signedIn: false });
    }
  }

  // Load reading and cache for the composite decisions below.
  const usage = providerAccountUsage(providerKey);
  const accountUsage = usage?.accounts.find(entry => entry.label === label) ?? null;
  const reading = buildReadingView(providerKey, usage, accountUsage, now);
  let cache = refusalFor(provider, label, model, accountUsage, now);
  const canonicalModel = provider === "claude-code" ? claudeUsageAllowanceModel(model) : model;

  // Step 1b — Account-reading-level signed-out verdict.
  if (accountUsage?.signedOut) {
    return makeVerdict(false, "signed-out", null,
      "latest reading says credentials are invalid",
      { home: homePath, liveRootMirror, signedIn: false, readingReadAtMs: reading.readAtMs ?? undefined });
  }

  // Step 2 — Cache + reading reconciliation.
  if (cache && cache.resetAtMs !== null && cache.resetAtMs > now) {
    if (reading.fresh && reading.problem === null && accountUsage && tryRetireCacheByReading(provider, label, canonicalModel, accountUsage, reading.readAtMs ?? now, cache)) {
      // Fall through — cache was just retired. M4 fix (2026-11-19): re-read the
      // local `cache` binding to null so Steps 4 and 5 can engage on the same
      // call. Before: Steps 4/5 were gated on `!cache` with the pre-retire value
      // still truthy, so the account couldn't be admitted via proven-attempt or
      // last-showed-room until the next call observed the retire.
      cache = null;
    } else {
      return makeVerdict(false, "cached-refusal", cache.resetAtMs,
        `account refused ${model} until ${new Date(cache.resetAtMs).toISOString()}`,
        { home: homePath, liveRootMirror, refusalScope: cache.scope,
          refusalResetAtMs: cache.resetAtMs, refusalObservedAtMs: cache.observedAtMs,
          overageReason: cache.overageReason ?? null, rateLimitType: cache.rateLimitType ?? null });
    }
  }

  // Step 3 — Fresh reading authority.
  if (reading.fresh && reading.problem === null && accountUsage) {
    const windows = includedAllowanceWindows(providerKey, accountUsage, canonicalModel);
    if (windows.length > 0) {
      const highestUsed = Math.max(...windows.map(w => Number.isFinite(w.usedPercent) ? w.usedPercent : 0));
      const lowestUsed = Math.min(...windows.map(w => Number.isFinite(w.usedPercent) ? w.usedPercent : 100));
      if (accountCanTakeWork(providerKey, accountUsage, canonicalModel)) {
        return makeVerdict(true, "ready", null,
          `fresh reading shows ${lowestUsed}% used`,
          { home: homePath, liveRootMirror, signedIn: true,
            readingReadAtMs: reading.readAtMs ?? undefined, readingFresh: true,
            readingUsedPercent: lowestUsed });
      }
      if (hasActiveFullAllowanceWindow(providerKey, accountUsage, canonicalModel, now)) {
        const earliestReset = earliestResetOfExhausted(accountUsage, now);
        return makeVerdict(false, "reading-exhausted", earliestReset,
          `fresh reading shows ${highestUsed}% used`,
          { home: homePath, liveRootMirror, readingReadAtMs: reading.readAtMs ?? undefined, readingFresh: true,
            readingUsedPercent: highestUsed });
      }
      // Codex fallback: credits may cover even when the primary window is spent.
      if (provider === "codex" && codexCreditsCanCover(accountUsage, now)) {
        return makeVerdict(true, "ready", null,
          "Codex paid credits cover the spent allowance",
          { home: homePath, liveRootMirror, readingReadAtMs: reading.readAtMs ?? undefined, readingFresh: true });
      }
    }
  }

  // Step 4 — Proven-attempt override. If the home ran a real turn recently, allow one attempt.
  if (provider === "claude-code" && homePath !== undefined) {
    const provenAt = readClaudeHomeProvenAt(homePath);
    if (provenAt !== null && (now - provenAt) < HOME_PROOF_WINDOW_MS) {
      return makeVerdict(true, "proven-attempt", null,
        `home proved by real turn at ${new Date(provenAt).toISOString()}`,
        { home: homePath, liveRootMirror, homeProvenAtMs: provenAt });
    }
  }

  // Step 5 — Last-good stale reading: a stale reading that showed room still is better
  // signal than no signal when nothing contradicts.
  if (!reading.fresh && reading.problem === null && accountUsage && !cache) {
    const windows = includedAllowanceWindows(providerKey, accountUsage, canonicalModel);
    if (windows.length > 0 && windows.every(w => Number.isFinite(w.usedPercent) && w.usedPercent < 100)) {
      const lowestUsed = Math.min(...windows.map(w => w.usedPercent));
      return makeVerdict(true, "last-showed-room", null,
        `stale reading showed ${lowestUsed}% used; no refusal cached`,
        { home: homePath, liveRootMirror, readingReadAtMs: reading.readAtMs ?? undefined, readingFresh: false, readingUsedPercent: lowestUsed });
    }
  }

  // Step 6 — Fallthrough.
  if (accountUsage?.problem || usage?.problem) {
    return makeVerdict(false, "reading-stale", null,
      "latest reading unreadable; cannot confirm room",
      { home: homePath, liveRootMirror, readingReadAtMs: reading.readAtMs ?? undefined, readingFresh: false });
  }
  return makeVerdict(false, "unknown", null, "no signal available",
    { home: homePath, liveRootMirror, readingReadAtMs: reading.readAtMs ?? undefined });
}

/**
 * Model-agnostic release view: "can this account take ANY work right now?"
 *
 * Walks the provider's allowance-model chain. Returns the first `ok:true` verdict.
 * If every model refuses with `cached-refusal`, returns the max `clearsAtMs`.
 *
 * This is the F1 fix: callers that don't have a model in context (release loop,
 * UI "has room" badge without a session) ask this question instead of calling
 * `claudeAccountCachedReset(acct, null)`, which spread Opus's refusal to every check.
 */
export function canTakeAnyWork(provider: ProviderId, account: AccountRef, now: number = Date.now()): CapabilityVerdict {
  const models = provider === "claude-code" ? [...CLAUDE_USAGE_FALLBACK_CHAIN]
    : provider === "codex" ? ["*"]
    : ["*"];
  let worstClearsAt: number | null = null;
  let lastVerdict: CapabilityVerdict | null = null;
  for (const model of models) {
    const verdict = canTakeWork(provider, account, model, now);
    if (verdict.ok) return verdict;
    lastVerdict = verdict;
    if (verdict.clearsAtMs !== null) {
      worstClearsAt = worstClearsAt === null ? verdict.clearsAtMs : Math.max(worstClearsAt, verdict.clearsAtMs);
    }
    // If a verdict is `no-home` / `signed-out` / `reading-stale`, further model checks won't help.
    if (verdict.reason !== "cached-refusal" && verdict.reason !== "reading-exhausted") {
      return verdict;
    }
  }
  if (!lastVerdict) return makeVerdict(false, "unknown", null, "no models to check", {});
  return makeVerdict(false, lastVerdict.reason, worstClearsAt,
    `every allowance model refused; latest clears ${worstClearsAt ? new Date(worstClearsAt).toISOString() : "unknown"}`,
    lastVerdict.source);
}

/** List accounts a provider has on this machine; each paired with its canonical home. */
export function listAccounts(provider: ProviderId): HomeRecord[] {
  if (provider === "antigravity") return [];  // Google lives in the CLI's keyring; no local homes
  return listHomeAccounts(provider);
}

/** Aggregate — how many accounts on this provider can take work right now, with min clearsAt. */
export function providerRoomBreakdown(provider: ProviderId, model: string, now: number = Date.now()): {
  ready: AccountRef[]; held: AccountRef[]; nextClearsAtMs: number | null;
  perAccount: Array<{ account: AccountRef; verdict: CapabilityVerdict }>;
} {
  const accounts = listAccounts(provider).map(home => ({ provider, label: home.label } as AccountRef));
  const perAccount = accounts.map(account => ({ account, verdict: canTakeWork(provider, account, model, now) }));
  const ready = perAccount.filter(entry => entry.verdict.ok).map(entry => entry.account);
  const held = perAccount.filter(entry => !entry.verdict.ok).map(entry => entry.account);
  const clearsAts = perAccount.map(entry => entry.verdict.clearsAtMs).filter((value): value is number => value !== null);
  const nextClearsAtMs = clearsAts.length ? Math.min(...clearsAts) : null;
  return { ready, held, nextClearsAtMs, perAccount };
}

type HomeView =
  | { kind: "none" }
  | { kind: "new-account-in-live-root"; path: string }
  | { kind: "resolved"; path: string | null; liveRootMirror: boolean };

function resolveHomeFor(provider: ProviderId, label: string): HomeView {
  if (provider === "antigravity") return { kind: "resolved", path: null, liveRootMirror: false };
  const result = resolveAccountHome(provider as ResolverProvider, label);
  if (result.kind === "none") return { kind: "none" };
  if (result.kind === "new-account-in-live-root") return { kind: "new-account-in-live-root", path: result.record.liveRoot };
  return { kind: "resolved", path: result.record.canonicalHome, liveRootMirror: result.record.liveRootMirror };
}

function readClaudeHomeProvenAt(home: string): number | null {
  const row = db.query("SELECT proven_at_ms FROM claude_home_proof WHERE home = ?").get(home) as { proven_at_ms: number } | null;
  return row ? row.proven_at_ms : null;
}

function refusalFor(provider: ProviderId, label: string, model: string, _accountUsage: AccountUsage | null, now: number): RefusalRecord | null {
  if (provider === "antigravity") return null;
  const codexAccountId = provider === "codex" ? codexAccountIdForLabel(label) : null;
  return cachedRefusal(provider as RefusalProvider, label, provider === "codex" ? null : model, codexAccountId, now);
}

type ReadingView = { readAtMs: number | null; fresh: boolean; problem: string | null; stale: boolean };

function buildReadingView(provider: ProviderId, usage: ProviderUsage | null, accountUsage: AccountUsage | null, now: number): ReadingView {
  if (!usage || !accountUsage) return { readAtMs: null, fresh: false, problem: null, stale: false };
  // A per-account `readAt` is the preferred timestamp (the readers set it); when it is
  // missing we fall back to the batch's `observedAt`, which is a safe lower bound on
  // every account's read time in that batch. Without the fallback, a reading inserted
  // without per-account readAt (fixtures, older readers) never counts as fresh and
  // Step 3 / the retire-by-reading path never engages — exactly the CI-RED behavior
  // the inbox-session-pin fixture surfaced.
  const perAccountReadAt = accountReadingAt(accountUsage);
  const observedAtMs = Date.parse(usage.observedAt ?? "");
  const readAtMs = perAccountReadAt ?? (Number.isFinite(observedAtMs) ? observedAtMs : null);
  const problem = accountUsage.problem ?? usage.problem ?? null;
  // Prefer the strict helper when it can decide. Only fall through to the
  // observedAt-based freshness when the strict helper refused solely because
  // the per-account readAt was absent.
  const strictFresh = accountReadingFresh(provider, usage, accountUsage, now);
  const freshViaObservedAt = perAccountReadAt === null && readAtMs !== null && problem === null
    && readAtMs <= now && (now - readAtMs) < ACCOUNT_READING_MAX_AGE_MS;
  const fresh = strictFresh || freshViaObservedAt;
  const stale = readAtMs !== null && (now - readAtMs) > ACCOUNT_READING_STALE_AFTER_MS;
  return { readAtMs, fresh, problem, stale };
}

function earliestResetOfExhausted(accountUsage: AccountUsage, now: number): number | null {
  const resets = accountUsage.windows
    .filter(window => Number.isFinite(window.usedPercent) && window.usedPercent >= 100)
    .map(window => Date.parse(window.resetsAt ?? ""))
    .filter(value => Number.isFinite(value) && value > now);
  return resets.length ? Math.min(...resets) : null;
}

function tryRetireCacheByReading(
  provider: ProviderId, label: string, allowanceModel: string,
  accountUsage: AccountUsage, readAtMs: number, cache: RefusalRecord,
): boolean {
  if (provider === "antigravity") return false;
  const windows = includedAllowanceWindows(provider, accountUsage, allowanceModel)
    .map(w => ({ usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null }));
  const retired = retireRefusalSupersededByReading(
    provider as RefusalProvider, label,
    provider === "codex" ? null : allowanceModel,
    windows, readAtMs,
    provider === "codex" ? codexAccountIdForLabel(label) : null,
  );
  if (retired) {
    log("info", "account_authority_retired_cache_by_reading", {
      provider, label, model: allowanceModel, read_at: new Date(readAtMs).toISOString(),
      refused_until: new Date(cache.resetAtMs!).toISOString(),
    });
  }
  return retired;
}

/**
 * Helper: for a model-agnostic view, the max reset across every allowance model's cache.
 * Prefer `canTakeAnyWork` when you have an `AccountRef`; this helper is for raw label strings
 * (migration callers from `claudeAccountCachedReset(..., null)`).
 */
export function anyWorkCachedResetForLabel(provider: ProviderId, label: string, now: number = Date.now()): number | null {
  if (provider !== "claude-code") {
    const records = cachedRefusalsForAccount(provider as RefusalProvider, label, now);
    return records.length ? Math.max(...records.map(r => r.resetAtMs ?? 0)) : null;
  }
  return anyWorkCachedReset(label, now);
}
