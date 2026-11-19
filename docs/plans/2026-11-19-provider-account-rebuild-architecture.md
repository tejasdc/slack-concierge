# Provider / account / dispatch — rebuild architecture

Status: design, 2026-11-19. Preceded by:
- `docs/incidents/2026-11-19-opus-only-refusal-blocked-every-claude-turn.md` — the failure the rebuild answers.
- `docs/plans/2026-11-19-multi-account-multi-provider-redesign.md` — the research fork's direction.
- `docs/plans/2026-11-19-provider-account-rebuild-inventory.md` — the full catalogue of what the rebuild replaces.

Scope: the account / provider / dispatch subsystem, from `canTakeWork` to the operator CLI. No band-aids; every current question routes through one authority. Preserves every dated incident reason as a named test.

## 1. Why this rebuild

The current system has at least twelve independent places that answer "is this account usable right now". They update on different cadences (a 429 refusal, a periodic `/usage` reading, a Mac keychain watch, a terminal `/login`), they interpret the answers differently (model-specific vs account-wide, with-cache vs without-cache, live-root vs per-account folder), and they disagree — the 2026-11-19 incident made the disagreement visible: the Accounts page said "Opus room remains · 39% weekly used", the dispatcher said "no account has room until Nov 22", and every Claude turn refused.

The band-aid at `worktree-multi-account-resolver-cache-fix` patched four of the twelve disagreements at the site where each one happened. This rebuild instead collapses the twelve into one: one authority answers the question, one home resolver returns the launch path, one refusal cache stores refusals, one parser extracts signals, every caller reads a view of the same AccountFacts module.

## 2. Core types

Every type below lives in `bot/src/account-authority.ts` unless noted. They are the new vocabulary.

```ts
// Identity and model.
export type ProviderId = 'claude-code' | 'codex' | 'antigravity' | 'chatgpt';
export type AccountLabel = string;              // user-visible identity (email)
export type Model = string;                     // canonical model id post-alias collapse

export type AccountRef = Readonly<{ provider: ProviderId; label: AccountLabel }>;

// Runs on a machine; one record per (provider, account) pair.
export type AccountRecord = Readonly<{
  ref: AccountRef;
  accountId: string | null;                     // provider's own id if known
  canonicalHome: string | null;                 // per-account folder; null for daemon/keychain-backed
  liveRootMirror: boolean;                      // live root also holds this same account
  signedIn: boolean;                            // credential file or Mac keychain says signed in
  credentialExpiresAtMs: number | null;
  selected: boolean;                            // this is the operator's current pick
  runnerBound: string | null;                   // ax41 | mac | null
}>;

// A reading from the provider's usage endpoint, per account.
export type ReadingWindowKind = 'five-hour' | 'weekly' | 'model-specific' | 'daily';

export type ReadingWindow = Readonly<{
  kind: ReadingWindowKind;
  model?: Model;                                // set for model-specific windows
  usedPercent: number | null;                   // null → unreadable
  resetsAtMs: number | null;
}>;

export type AccountReading = Readonly<{
  ref: AccountRef;
  readAtMs: number;                             // when this reader took the measurement
  sourceTimeMs: number | null;                  // when the provider reported it (if different from readAtMs)
  fresh: boolean;                               // readAtMs within ACCOUNT_READING_MAX_AGE_MS
  stale: boolean;                               // readAtMs older than ACCOUNT_READING_STALE_AFTER_MS (one week)
  windows: readonly ReadingWindow[];
  problem: string | null;                       // reader-level error (e.g. "could not be read")
  signedOut: boolean;                           // provider said the credential is invalid
  source: 'cswap' | 'claude-own' | 'codex-direct' | 'google-cli' | 'peer' | null;
}>;

// A refusal cached from an actual 429 or equivalent.
export type RefusalRecord = Readonly<{
  provider: ProviderId;
  accountLabel: AccountLabel;
  model: Model | null;                          // null only for Codex (account-wide)
  scope: string;                                // "<accountHash>:<canonicalModel>" or "<accountId>" for Codex
  resetAtMs: number | null;
  observedAtMs: number;
  generation: number;
  revision: number;
}>;

// The one verdict produced by the one authority.
export type CapabilityReason =
  | 'ready'                                     // ok
  | 'no-home'                                   // this machine cannot launch this account
  | 'signed-out'                                // credentials missing or stale
  | 'cached-refusal'                            // model-specific refusal within its reset
  | 'reading-exhausted'                         // fresh reading shows the window at or above 100%
  | 'reading-stale'                             // last reading too old to trust and no proof override
  | 'proven-attempt'                            // granted on recent home-proof despite missing reading
  | 'last-showed-room'                          // stale reading but the last good one showed room
  | 'unknown';                                  // no signal

export type CapabilityEvidence = Readonly<{
  home?: string;
  signedIn?: boolean;
  readingReadAtMs?: number;
  readingFresh?: boolean;
  readingUsedPercent?: number | null;
  refusalScope?: string;
  refusalResetAtMs?: number | null;
  refusalObservedAtMs?: number;
  homeProvenAtMs?: number;
  liveRootMirror?: boolean;
  conflictsWith?: CapabilityVerdict;            // only set when two signals disagreed
}>;

export type CapabilityVerdict = Readonly<{
  ok: boolean;
  reason: CapabilityReason;
  clearsAtMs: number | null;                    // when the block lifts, if known
  why: string;                                  // short human-readable, stable
  source: CapabilityEvidence;
}>;
```

### Chosen over alternatives

**Why one `AccountRecord` and not separate claude/codex/google**: today the per-provider branches tolerated a new provider silently missing from a check — the same bug `provider-contract.ts` already solves at the capability layer. Keeping one record with a `provider` tag is already how `provider-contract.ts` works; `AccountRecord` extends the same discipline to accounts.

**Why `model: Model | null` on `RefusalRecord`**: Codex refuses at the account level (its usage API answers "this account has no room") while Claude refuses per model. Two separate types would force every caller to branch on provider; one nullable field preserves the shape and is enforced at the typing layer (Codex writer always sets `null`; Claude writer never sets `null`).

**Why `clearsAtMs: number | null` and not throwing**: today's `claudeEveryAccountClearsAt` reads the clearsAt by catching a `ProviderDispatchError`. That is control-flow by exception for a value that is fundamentally structured. The new verdict carries `clearsAtMs` directly.

## 3. The one authority — `canTakeWork`

```ts
// bot/src/account-authority.ts
export function canTakeWork(
  provider: ProviderId,
  account: AccountRef,
  model: Model,
  now?: number,
): CapabilityVerdict;
```

Algorithm, strict order (every clause names the dated incident it preserves):

**Step 0 — Resolve.** `home = resolveAccountHome(provider, account.label)`.
- If `home.kind === 'none'` → `{ ok:false, reason:'no-home', clearsAtMs:null, why:'no runnable home on this machine', source:{} }`.
  Preserves `2026-11-02 mac-signin-wait-read-as-usage` — an account with 54% free on `/usage` but no runnable home here is not a dispatchable account.
- If `home.kind === 'new-account-in-live-root'` → same as above, with `source.liveRootMirror = true` and a `provider_home_new_account_in_live_root` log. The migration CLI handles adopting.
- If `home.kind === 'resolved'` → continue with `home.path` as the launch home, `home.liveRootMirror` noted on the verdict evidence.

**Step 1 — Credential state.** Read `home.signedIn` and `home.credentialExpiresAtMs`.
- If `!home.signedIn` → `{ ok:false, reason:'signed-out', clearsAtMs:null, why:'credentials missing or expired', source:{home:home.path,signedIn:false} }`.
  Preserves `2026-11-02 mac-signin-wait-read-as-usage` (room with sign-out is not a dispatch route) and `2026-11-13 expired-access-token-read-as-signed-out` (a refresh-token-live but access-token-expired home is not signed-out yet).
- If credential expires within 60 seconds AND the provider is Codex: refuse with `signed-out` so renewal fires. Preserves `2026-10-06 token-expired` triple.

**Step 2 — Load cache and reading.** Compute `cache = refusalCache.get(provider, account.label, canonicalModel(model))` and `reading = readings.latest(provider, account.label)`.

**Step 3 — Cache retirement by reading (generic).** If `cache && cache.resetAtMs !== null && cache.resetAtMs > now`:
- If `reading !== null` and `reading.readAtMs > cache.observedAtMs` and `reading.fresh` and `reading.problem === null` and **every** included window for this model is `< 100%` and **no** window's `resetsAtMs` is within 60 seconds of `cache.resetAtMs`:
  - `refusalCache.retire(cache)`; log `provider_cache_superseded_by_reading`.
  - Fall through to Step 4.
  Preserves `2026-11-06 codex retirement rule` applied generically. Preserves the Opus-only poison F1 by scoping the cache to `canonicalModel(model)`.
- Otherwise → `{ ok:false, reason:'cached-refusal', clearsAtMs:cache.resetAtMs, why:'account refused ${model} until ${cache.resetAtMs}', source:{refusalScope,...} }`.

**Step 4 — Fresh reading authority.** If `reading !== null && reading.fresh && reading.problem === null`:
- `windows = includedAllowanceWindows(reading.windows, canonicalAllowanceModel(model))` (Opus 1M collapses to Opus).
- If `windows.length === 0` → fall through to Step 6. Preserves `2026-10-30 Ultra 5-hour removal` — some accounts have no 5-hour window at all.
- If `windows.some(w => w.usedPercent !== null && w.usedPercent < 100)` → `{ ok:true, reason:'ready', clearsAtMs:null, why:'reading shows ${lowest}%', source:{readingUsedPercent,...} }`.
- If `windows.every(w => w.usedPercent !== null && w.usedPercent >= 100)` → `{ ok:false, reason:'reading-exhausted', clearsAtMs:earliestResetMs(windows), why:'fresh reading says every window full', source:{...} }`.
- Else → fall through to Step 5 (windows with null usedPercent are unknown).

**Step 5 — Proven attempt within 10 minutes.** If `home.provenAtMs !== null && now - home.provenAtMs < 10*60_000`:
- `{ ok:true, reason:'proven-attempt', clearsAtMs:null, why:'succeeded within 10m', source:{homeProvenAtMs,...} }`.
  Preserves `2026-10-10 usage-percentage-zero-while-claude-refused` — a proven account can take work even when readings say otherwise.

**Step 6 — Last-good stale reading.** If `reading !== null && (reading.stale || !reading.fresh) && reading.problem === null` and the last-good window for this model showed `usedPercent < 100`:
- `{ ok:true, reason:'last-showed-room', clearsAtMs:null, why:'stale reading showed ${lowest}% as of ${reading.readAtMs}', source:{...} }`.
  Preserves `2026-10-15 19%-account-hidden-by-stale-reading` — a stale reading that still shows room is better than no account at all.

**Step 7 — Fallthrough.**
- If reading exists but is problem-tagged or stale with no last-good → `{ ok:false, reason:'reading-stale', clearsAtMs:null, why:'reading unreadable since ${lastFreshAt}', source:{...} }`.
- Otherwise → `{ ok:false, reason:'unknown', clearsAtMs:null, why:'no signal', source:{} }`.

### Model-agnostic release view

For callers asking "can this account take ANY work right now" (release loop, UI "has room" badge without a model context), the authority exposes:

```ts
export function canTakeAnyWork(provider: ProviderId, account: AccountRef, now?: number): CapabilityVerdict;
```

Implementation: walk the model allowance chain (fable → opus → sonnet → haiku for Claude, single `*` for Codex, model-agnostic for Google) calling `canTakeWork` for each; return the first `ok:true` verdict, or the max `clearsAtMs` across all refusals. This is the F1 fix generalized — model-specific refusals stay model-specific, and a one-model refusal never blocks the "any work" question unless every model refuses.

### Conflict logging

Whenever Step 3 retires a cache, log `provider_cache_superseded_by_reading`. Whenever two signals in the evidence contradict (example: a fresh reading shows room but a cache says refused, when not retired because the resets match within 60s), log `provider_authority_contradiction` with both sides as structured payload. This is how we measure the system is converging.

## 4. Home resolution — `resolveAccountHome`

```ts
// bot/src/account-home-resolver.ts
export type ResolveHomeResult =
  | { kind: 'none' }
  | { kind: 'resolved'; path: string; liveRootMirror: boolean; provenAtMs: number | null; signedIn: boolean; credentialExpiresAtMs: number | null }
  | { kind: 'new-account-in-live-root'; path: string; label: AccountLabel };  // migration hint, not a launchable home

export function resolveAccountHome(provider: ProviderId, label: AccountLabel): ResolveHomeResult;
```

Algorithm:

1. Enumerate candidates: `[liveRoot(provider), ...perAccountFolders(provider)]`.
2. For each candidate, read its credential + identity (same code as today's `claudeAccount` / `codexAccount`).
3. Build a map `labelsByHome: Map<string, AccountLabel>` and then invert it to `homesByLabel: Map<AccountLabel, string[]>`.
4. Look up `label`:
   - If `homesByLabel.has(label)`: pick the entry whose path is NOT `liveRoot(provider)` if one exists; otherwise the live-root entry. Return `kind:'resolved'`, `liveRootMirror: true` iff `liveRoot` also resolved to this label.
   - Else: if `liveRoot` resolved to some new label that has no per-account folder yet, return `kind:'new-account-in-live-root'`. Else return `kind:'none'`.

**The structural fix for F3**: the dedup is by `account_label`, not by `home_path`. The live root is never a second candidate for an account already held in a per-account folder.

**New-account-in-live-root signal**: lets the runner notice that the user did `claude /login` for a fresh account (with no per-account folder yet) and surface a one-command migration without calling it a dispatch refusal. The `accounts.validate` RPC returns `{ available: true, resolution: 'unique' }` whenever a label is in `homesByLabel`; the live-root-only case returns `{ available: false, resolution: 'new-in-live-root', migration: '<label>' }`.

### Live-root mirror as benign

A live-root that resolves to the same label as a per-account folder is logged once (`provider_home_duplicate_live_root`) and otherwise ignored for dispatch. The user's shell is the user's shell; it never changes what agents can do.

### Callers to migrate

Every current caller of `runnerAccountHomes` is listed in `inv-call-sites.md` under that symbol. Each caller is rewritten to call either:
- `resolveAccountHome(provider, label)` when asking a question about one account.
- `listAccounts(provider)` when enumerating (replaces `runnerAccountHomes`).

The old `runnerAccountHomes` is removed. The band-aid's `namedRunnerAccountHomes` is removed. `fileClaudeSignIn` at `runner-provider-accounts.ts:324` is rewritten to use `resolveAccountHome`.

## 5. Refusal cache — `account-refusal-cache.ts`

Lives at `bot/src/account-refusal-cache.ts`. Extracted from today's `provider-usage.ts` so provider-usage.ts becomes the home of structured observations, not a grab-bag of cache utilities.

```ts
export function recordRefusal(ref: AccountRef, model: Model | null, resetAtMs: number | null, observedAtMs?: number): RefusalRecord;
export function cachedRefusal(provider: ProviderId, label: AccountLabel, model: Model | null): RefusalRecord | null;
export function retireRefusal(refusal: RefusalRecord, reason: 'reading-superseded' | 'success' | 'expired' | 'manual-clear' | 'generation-bump'): boolean;
export function clearScoped(provider: ProviderId, label?: AccountLabel, model?: Model): { cleared: number; generation: number };
export function clearAll(provider: ProviderId): { cleared: number; generation: number };
```

Scope convention: `<provider>::<accountHash>::<canonicalAllowanceModel>` where `accountHash = sha256(label.toLowerCase()).slice(0,24)` and `canonicalAllowanceModel` runs the Claude Opus-1M collapse (today's `claudeUsageAllowanceModel`). For Codex, the model component is the literal `*`, since Codex refuses per-account.

Invariants:
- A record is a tombstone for exactly that `(provider, label, allowance-model)` triple. The old wildcard `claudeAccountCachedReset(account, null)` is deleted; model-agnostic callers go through `canTakeAnyWork` which walks the chain explicitly.
- `generation` bumps atomically on `clearAll`; a late write from a prior generation is ignored.
- `revision` bumps per-scope so a concurrent update can order against itself.
- Expired records (resetAtMs <= now) are swept lazily on read.

## 6. Rate-limit signals — `rate-limit-signals.ts`

Lives at `bot/src/rate-limit-signals.ts`. The Claude CLI stream parser delegates all rate-limit interpretation here.

```ts
export type RateLimitSignals = {
  sawStructuredAllowed: boolean;           // rate_limit_event with status allowed/warning
  sawStructuredRejected: boolean;          // rate_limit_event with status rejected
  structuredResetAtMs: number | null;      // from the rejected event
  syntheticExhausted: boolean;             // <synthetic> message text matched usage-exhaustion pattern
  syntheticResetAtMs: number | null;       // parsed from synthetic text
  conflict: null | { kind: 'synthetic-overrides-structured' | 'reset-mismatch'; detail: string };
};

export function emptySignals(): RateLimitSignals;
export function observeRateLimitEvent(signals: RateLimitSignals, event: RateLimitEventPayload): void;
export function observeSyntheticText(signals: RateLimitSignals, text: string): void;
export function clearSignals(signals: RateLimitSignals): void;  // called at turn restart / model switch
export function terminalVerdict(signals: RateLimitSignals): { usageExhausted: boolean; resetAtMs: number | null };
```

The terminal rule:
```ts
terminalVerdict(s) {
  if (s.sawStructuredRejected) return { usageExhausted: true, resetAtMs: s.structuredResetAtMs };
  if (s.sawStructuredAllowed)  return { usageExhausted: false, resetAtMs: null };  // structured beats synthetic
  if (s.syntheticExhausted)    return { usageExhausted: true, resetAtMs: s.syntheticResetAtMs }; // no structured; trust synthetic
  return { usageExhausted: false, resetAtMs: null };
}
```

`observeRateLimitEvent` **latches**: once `sawStructuredAllowed` is set, an unrelated later `allowed` event does not reset it (and `sawStructuredRejected` is set the same way, except `clearSignals` is called on model switch). This differs from today's non-latched `usageRejected` at `claude-code.ts:1147`, which the parser inventory identified as a hazard.

Whenever `observeSyntheticText` sets `syntheticExhausted = true` AND `sawStructuredAllowed === true`, the signals' `conflict` is set to `synthetic-overrides-structured` so the turn's conclusion logs `claude_synthetic_overridden_by_structured_event` with the synthetic excerpt. This is the F4 fix.

The parser in `claude-code.ts` is rewritten to:
- Keep one `RateLimitSignals` object per turn.
- At `rate_limit_event`: call `observeRateLimitEvent`.
- At assistant text with `<synthetic>` model: call `observeSyntheticText(signals, text)`. The `<synthetic>` filter still prevents `agentSpoke` (for its original purpose: a synthetic row isn't the agent working), but synthetic text is no longer pushed into `messageParts` for terminal interpretation; only the signals object sees it.
- At model switch: `clearSignals` so a successor model's verdict is independent.
- At terminal: call `terminalVerdict(signals)`; if `usageExhausted`, `refusalCache.recordRefusal(ref, model, resetAtMs)`.

## 7. Dispatch — `chooseDispatch`

Lives at `bot/src/provider-account-dispatch.ts`, rewritten.

```ts
export type DispatchChoice =
  | { kind: 'launch'; account: AccountRef; home: string; verdict: CapabilityVerdict }
  | { kind: 'hold'; clearsAtMs: number | null; perAccount: Array<{ account: AccountRef; verdict: CapabilityVerdict }> };

export function chooseDispatch(provider: ProviderId, session: SessionLike, model: Model, now?: number): DispatchChoice;
```

Full body (target under 100 lines):

```ts
export function chooseDispatch(provider, session, model, now = Date.now()) {
  const accounts = listAccounts(provider);
  const scored = accounts.map(acct => ({ acct, verdict: canTakeWork(provider, acct.ref, model, now) }));
  const eligible = scored.filter(s => s.verdict.ok);
  if (eligible.length === 0) {
    const nextClearsAtMs = Math.min(...scored.map(s => s.verdict.clearsAtMs ?? Infinity));
    return { kind: 'hold', clearsAtMs: Number.isFinite(nextClearsAtMs) ? nextClearsAtMs : null, perAccount: scored.map(s => ({ account: s.acct.ref, verdict: s.verdict })) };
  }
  const picked = rankCandidates(eligible, session, model);  // see §7.1
  return { kind: 'launch', account: picked.acct.ref, home: picked.verdict.source.home!, verdict: picked.verdict };
}
```

Every one of today's nine gates in `chooseClaudeDispatch` is replaced by one call to `canTakeWork` plus a ranker. The gates' dated-reason comments are preserved on the ranker's sort predicate (see §7.1).

### 7.1 `rankCandidates` — the only remaining decision

With `eligible` as "accounts that can take this work right now", the ranker picks among them:

```ts
rankCandidates(eligible, session, model):
  // 1. Selection: the operator's current pick, if eligible, always wins.
  //    Preserves 2026-11-16 "every provider has an in-use account" and 2026-10-09
  //    "selected account was excluded, read as no account has room".
  const selected = eligible.find(s => s.acct.selected);
  if (selected) return selected;

  // 2. Warm prefix: if session.lastAccount is eligible, prefer it. Preserves 2026-11-15
  //    warm-stay-band — we don't flip accounts between turns for small deltas.
  const lastUsed = eligible.find(s => s.acct.ref.label === session.lastAccount);
  if (lastUsed) return lastUsed;

  // 3. Most room, then latest reset. Preserves 2026-11-16 "aggregated room per provider,
  //    not biggest-account". Here we are inside one provider so we use that provider's
  //    reading rank.
  return eligible.sort((a, b) => roomPercent(b, model) - roomPercent(a, model) || (b.verdict.clearsAtMs ?? 0) - (a.verdict.clearsAtMs ?? 0))[0]!;
```

### 7.2 Removed today

- `chooseClaudeDispatch`'s nine-gate ladder — gone.
- `claudeAccountLaunchableHere` — replaced by `canTakeWork(provider, acct, model).ok`.
- `claudeAccountWithRoomBesides` — replaced by `listAccounts(provider).filter(a => a.ref.label !== x && canTakeWork(...).ok)`.
- `claudeHeldWorkCanRun` — replaced by `canTakeAnyWork(provider, acct).ok`.
- `claudeEveryAccountClearsAt` — replaced by the `kind:'hold'` branch above.
- `accountUsedPercent` — replaced by `roomPercent(verdict, model)` helper on the verdict's `source.readingUsedPercent`.

## 8. Cross-provider failover — declared `provider_chain`

Today's `recoverExhaustedClaudeWork` uses `newWorkCapacity('claude-code').used >= 100 && newWorkCapacity('codex').used < 100` — a percentage check blind to caches. The rebuild makes failover a declared order that walks `canTakeWork`:

### 8.1 Schema change

Add a nullable `provider_chain` column to `sessions`:

```sql
ALTER TABLE sessions ADD COLUMN provider_chain TEXT;  -- JSON array of ProviderId
```

A session's `provider_chain` is set at creation from either (a) an explicit operator choice, (b) a saved-work preference, or (c) the default `[provider]` (no failover). Existing sessions get `NULL` and behave as today's single-provider sessions until explicitly updated.

### 8.2 Transfer rule

```ts
export function recoverExhaustedWork(sessionId: number, now?: number): TransferDecision;

function recoverExhaustedWork(sessionId, now = Date.now()) {
  const session = getSessionById(sessionId);
  const chain = session.provider_chain ?? [session.provider_id];
  if (chain.length < 2) return { kind: 'no-chain' };

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]!;
    const providerClearsAt = earliestClearsAtAcrossAccounts(provider, session.model, now);
    if (providerClearsAt === 'ready') {
      if (i === 0) return { kind: 'stay' };
      return { kind: 'transfer', to: provider };
    }
    // else: provider exhausted; record per-account refusal reasons on session
  }
  return { kind: 'hold', clearsAt: minClearsAtAcross(chain) };
}
```

Replaces the percentage-based gate. The Nov 19 incident would fire because `canTakeAnyWork('claude-code', ...)` returned `{ok:false, reason:'cached-refusal'}` for every Claude account even though `/usage` said 39% — Codex would be considered.

### 8.3 Accounts' read of the chain

The new UI badge producer displays, per session, which provider in the chain is currently selected and which is next. A transfer records a `provider_recovery_transferred` event (unchanged from today) plus a new `provider_chain_advanced` event carrying the `from/to` providers and the per-account verdicts that triggered the decision.

## 9. Operator CLI surface

Every intervention today's investigation needed by hand gets a named command.

### `router-actions.sh accounts status [--provider P] [--account A] [--json]`

Prints the AccountRecord table. For each row: provider, label, canonical home, selected flag, signed-in flag, credential expires at, runner binding, last reading percent per included window, latest cached refusal (model + reset), proven at, live-root mirror flag.

### `router-actions.sh accounts verdict <provider> <account> <model> [--now <iso>]`

Calls `canTakeWork` with the given args and prints the verdict's `ok`, `reason`, `clearsAtMs`, `why`, and `source` as JSON. The operator can diagnose exactly why a dispatch decision is what it is.

### `router-actions.sh accounts usage-clear <provider> [--account A] [--model M] [--all]`

Scoped refusal-cache clear. Default (no flags) refuses with an explanation; `--all` clears every scope of the provider; `--account A` clears every scope of that account; `--account A --model M` clears exactly that scope. Prints `cleared: N, generation: G`.

### `router-actions.sh accounts refresh <provider> [--account A] [--machine M]`

Force a fresh reading on the named account, bypassing the periodic reader's five-minute per-account cooldown. Returns the fresh reading JSON.

### `router-actions.sh accounts adopt-live-root <provider>`

When `resolveAccountHome` returned `new-account-in-live-root` for some label, migrate the live-root login into the canonical per-account folder. Steps: create the folder with `claude-home-entries` linkage, copy `.credentials.json` from live root, verify the per-account folder reads the same account via `claudeAccount`, then empty the live root's `.credentials.json` (leaving it signed out).

### `router-actions.sh accounts provider-chain <session> <ID> [--set p1,p2,...] [--clear]`

Set or clear a session's `provider_chain`. The `<session>` parameter is a Concierge session address. On set, the session's next held-work scan considers transfer.

### `router-actions.sh accounts invalidate-stale <provider> [--account A] [--older-than <days>]`

Explicitly drop a reader's stored stale copy; the next reader cycle will fetch fresh.

### Why this namespace

The runner RPC family at `runner-provider-accounts.ts:825-891` already uses `accounts.*`. Keeping the CLI under `accounts <verb>` matches the RPC verb list, reads as "operator talks to the accounts subsystem", and avoids the band-aid's choice of top-level `usage-clear` which is less consistent with the rest of the operator surface.

## 10. UI readers

Two consolidations:

### 10.1 One `providerAuthView`

`provider-auth-read.ts:providerAuthView` and `session-execution-host.ts:providerAuthView` are near-line-for-line duplicates reading the same stores. One wins (`provider-auth-read.ts`); the other becomes a thin adapter. Both are rewritten to call the authority instead of reading `provider_account_usage` and building a `hasRoom` locally.

### 10.2 One `hasRoom` producer

`account-allowance-observation.ts:markUncurrentAccountReadings` is rewritten to call `canTakeWork(provider, acct, allowanceModelOf(acct), now)` per account per included model and emit:

```ts
account.allowance = {
  observedAtMs: reading.readAtMs,
  evaluatedAtMs: now,
  validUntilMs: reading.readAtMs + ACCOUNT_READING_MAX_AGE_MS,
  status: statusFromVerdict(verdict),      // 'ready' | 'refused' | 'signed-out' | 'stale' | 'unknown'
  hasRoom: verdict.ok,                     // was: reading-only; now: authority-derived
  perModel: {                              // per-model verdicts so the UI can show "Opus exhausted · Sonnet ready"
    [model]: { ok, reason, clearsAtMs, why }
  },
};
```

The UI reads `allowance.perModel` and surfaces the per-model badge. The November 19 "Opus room remains" would never have appeared — `canTakeWork('claude-code', hey@, 'opus', now)` returned `ok:false` because of the cached refusal, and the UI shows that.

### 10.3 Notice path

`provider-usage-notice.ts:noticeUsageHold` is rewritten to call `canTakeWork` for each account+model instead of maintaining its own join of reading + cache. The notice fields become: `perAccount: [{label, verdict}]`, `nextClearsAtMs`, `alternatives` (eligible accounts).

## 11. Migration

### 11.1 Schema

Add two tables:

```sql
CREATE TABLE IF NOT EXISTS provider_accounts (
  provider TEXT NOT NULL,
  account_label TEXT NOT NULL,
  account_id TEXT,
  canonical_home TEXT,
  live_root_mirror INTEGER NOT NULL DEFAULT 0,
  signed_in INTEGER NOT NULL DEFAULT 0,
  credential_expires_at_ms INTEGER,
  selected INTEGER NOT NULL DEFAULT 0,
  runner_bound TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (provider, account_label)
);

CREATE TABLE IF NOT EXISTS provider_capability_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at_ms INTEGER NOT NULL,
  provider TEXT NOT NULL,
  account_label TEXT NOT NULL,
  model TEXT NOT NULL,
  verdict_ok INTEGER NOT NULL,
  reason TEXT NOT NULL,
  clears_at_ms INTEGER,
  why TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_capability_log_lookup ON provider_capability_log (provider, account_label, observed_at_ms);

ALTER TABLE sessions ADD COLUMN provider_chain TEXT;
```

### 11.2 Data

- `provider_accounts` is re-materialized at boot from `runnerAccountHomes` + `provider_account_selection` + `provider_account_usage` + `claude_home_proof` + credential files/keychain.
- `provider_usage_cache` stays as the refusal store; the new `account-refusal-cache.ts` reads/writes the same rows. The `generation`/`revision` columns are reused unchanged; the `scope` column gets a stricter format checker that refuses writes without the `<provider>::<accountHash>::<model>` shape.
- `provider_account_usage` and `provider_usage_readings` stay. The authority reads them through the `readings` module; writers (reader loops) are unchanged.
- `claude_home_proof` stays.
- `provider_account_selection` stays.

No data is thrown away. The rebuild adds one table and one column.

### 11.3 Boot order

The authority has no init of its own. On first query:
- Open the SQLite handle (shared with everything else).
- Run `provider_accounts` re-materialization if the table is empty (idempotent pure function over the other tables).
- Register the capability log sink.

No partial activation — on deploy, the new code paths are live for every caller simultaneously. The old `claudeAccountCachedReset(…, null)` is removed, so any caller that didn't migrate fails to compile.

### 11.4 What gets deleted

The following primitives, each listed with its replacement:

| Deleted | Replacement |
| --- | --- |
| `claudeAccountCachedReset(acct, null)` | `canTakeAnyWork(provider, acct)` |
| `claudeAccountCachedReset(acct, model)` | `cachedRefusal(provider, label, model)` via `account-refusal-cache.ts` |
| `accountCanTakeWork(provider, acct, model)` | `canTakeWork(provider, acct.ref, model).ok` |
| `hasActiveFullAllowanceWindow(provider, acct, model)` | `canTakeWork(...).reason === 'reading-exhausted'` |
| `claudeAccountLaunchableHere(acct)` | `canTakeWork(...).ok || canTakeWork(...).reason === 'cached-refusal'` |
| `claudeAccountWithRoomBesides(acct, model)` | `listAccounts(provider).filter(a => a.label !== acct && canTakeWork(...).ok)` |
| `claudeHeldWorkCanRun(model?)` | `listAccounts(provider).some(a => canTakeAnyWork(...).ok)` |
| `claudeEveryAccountClearsAt(model?)` | `minClearsAtAcross(listAccounts(provider))` |
| `accountUsedPercent(provider, acct, model?)` | `roomPercent` helper on verdict evidence |
| `newWorkCapacity(provider)` (as a dispatch signal) | `chooseDispatch(provider, session, model).kind === 'launch'` |
| `runnerAccountHomes(provider)` | `listAccounts(provider)` |
| `namedRunnerAccountHomes(provider, label)` (band-aid) | `resolveAccountHome(provider, label)` |
| `clearProviderUsage(provider)` (as the only clear) | `clearScoped` / `clearAll` on `account-refusal-cache.ts` |
| `cachedUsageLimit(attempt)` used by non-adapter callers | `cachedRefusal(...)` |
| `storedUsage(provider)` as a dispatch signal | reading pipeline via authority |

The deleted callers go through the new authority. The `provider_usage_cache` table itself survives — the module `account-refusal-cache.ts` is its one new reader/writer.

## 12. Test plan

### 12.1 Named incident replays

`bot/tests/incidents/<YYYY-MM-DD>-<slug>.test.ts` — one file per preserved dated reason. The file's top comment quotes the reason verbatim. Minimum list (final list is the full inventory's section 3):

- `2026-09-15-codex-usage-limit-scope.test.ts` — one Codex account's limit must not poison another's.
- `2026-09-22-usage-limit-silent-stop.test.ts` — a refused turn with a stated reset waits, does not die.
- `2026-10-07-codex-account-listed-twice.test.ts` — identity dedup for Codex.
- `2026-10-07-account-switch-stripped-agent-abilities.test.ts` — symlinked shared entries in per-account folders.
- `2026-10-09-every-account-reset-floor.test.ts` — one account's reset must not be announced as every account's.
- `2026-10-10-usage-percentage-zero-while-claude-refused.test.ts` — proven-attempt override.
- `2026-10-15-stale-reading-hid-account.test.ts` — last-showed-room override.
- `2026-11-02-mac-signin-wait-read-as-usage.test.ts` — room without home is not dispatchable.
- `2026-11-02-opus-1m-shares-opus-allowance.test.ts` — canonicalAllowanceModel collapses Opus-1M → Opus.
- `2026-11-03-inbox-held-after-new-account.test.ts` — sign-in activation releases usage holds.
- `2026-11-03-usage-reader-missed-new-account.test.ts` — reading-level account discovery.
- `2026-11-06-inactive-codex-reset-hidden-from-switch.test.ts` — Codex retirement by reading.
- `2026-11-13-expired-access-token-read-as-signed-out.test.ts` — expired access token with live refresh token is not signed-out.
- `2026-11-15-warm-cache-kept-spending-later-week.test.ts` — warm-stay-band on ranker.
- `2026-11-16-new-work-choice-weighed-one-account-per-provider.test.ts` — aggregated room per provider.
- `2026-11-19-opus-only-refusal-blocked-every-claude-turn.test.ts` — F1 through F4 combined.

### 12.2 State transitions on `canTakeWork`

`bot/tests/account-authority.test.ts` — one test per state transition:

- fresh reading <100% → ok:ready
- fresh reading ≥100% → ok:false, reading-exhausted, clearsAtMs set
- cache (model-specific), no reading → ok:false, cached-refusal
- cache (Opus), reading fresh with Weekly 39% → cache retired, ok:ready
- stale reading with last-good <100% → ok:true, last-showed-room
- no reading, home proven within 10m → ok:true, proven-attempt
- no reading, no proof, stale reading unreadable → ok:false, reading-stale
- no home → ok:false, no-home
- home exists but signed-out → ok:false, signed-out
- live-root mirror present → ok:true with liveRootMirror evidence
- live-root resolves to new account → `new-account-in-live-root`

### 12.3 Home resolver

`bot/tests/account-home-resolver.test.ts`:
- per-account folder only → resolved, mirror false.
- live root signed in to same account as per-account folder → resolved, mirror true.
- live root signed in to new label → new-account-in-live-root.
- Multiple per-account folders for the same label (shouldn't happen, but): first wins deterministically.

### 12.4 Rate-limit signals

`bot/tests/rate-limit-signals.test.ts`:
- structured rejected only → usageExhausted true, reset set
- structured allowed only → usageExhausted false
- synthetic exhausted only → usageExhausted true, reset parsed
- structured allowed + synthetic exhausted → usageExhausted false, conflict logged
- structured rejected + synthetic allowed-looking text → usageExhausted true, no conflict
- clearSignals resets flags on model switch

### 12.5 Dispatch integration

`bot/tests/provider-account-dispatch-authority.test.ts`:
- Two accounts; both ok → selected wins, then warm-stay-band.
- Two accounts; selected exhausted, other ok → other picked.
- Every account exhausted → hold with min clearsAtMs.
- Cross-provider: `provider_chain = [claude, codex]`, Claude exhausted, Codex ok → transfer.

### 12.6 Cache retirement

`bot/tests/account-refusal-cache.test.ts`:
- Record refusal, read back.
- Retirement by reading when windows < 100% and resets diverge.
- Retirement blocked when a window's reset matches cache's reset within 60s.
- Retirement blocked when reading is older than cache.
- Scoped clear: one model, leave others.
- Clear all: generation bump.

## 13. Files to add / delete / rewrite

### 13.1 Add

- `bot/src/account-authority.ts` — `canTakeWork`, `canTakeAnyWork`, core types.
- `bot/src/account-home-resolver.ts` — `resolveAccountHome`, `listAccounts`.
- `bot/src/account-refusal-cache.ts` — `recordRefusal`, `cachedRefusal`, `retireRefusal`, `clearScoped`, `clearAll`.
- `bot/src/rate-limit-signals.ts` — `RateLimitSignals`, `observeRateLimitEvent`, `observeSyntheticText`, `terminalVerdict`.
- `bot/src/account-facts.ts` — `listAccounts`, `getAccountRecord`, `markSelected`, `markProven`, writer-side for `provider_accounts`.
- `bot/scripts/router-accounts.ts` — the CLI entrance for every `accounts <verb>` command.
- `bot/tests/account-authority.test.ts` — core authority state transitions.
- `bot/tests/account-home-resolver.test.ts` — F3 replays and resolver contract.
- `bot/tests/rate-limit-signals.test.ts` — F4 replays.
- `bot/tests/account-refusal-cache.test.ts` — scope semantics.
- `bot/tests/provider-account-dispatch-authority.test.ts` — rewriter sanity tests.
- `bot/tests/incidents/*.test.ts` — one per preserved dated reason (minimum list in §12.1).

### 13.2 Rewrite

- `bot/src/provider-account-dispatch.ts` — `chooseClaudeDispatch` body collapses to §7 (target: under 100 lines).
- `bot/src/provider-account-usage.ts` — release loop calls `canTakeWork` once per account; inline guards deleted.
- `bot/src/provider-exhaustion-recovery.ts` — `recoverExhaustedWork(sessionId)` walks `provider_chain` as §8.
- `bot/src/provider-usage-forecast.ts` — `accountAvailability` becomes a thin wrapper over `canTakeWork`; `providerTotalRoom` sums `canTakeWork(...).source.readingUsedPercent`.
- `bot/src/account-allowance-observation.ts` — `markUncurrentAccountReadings` writes `allowance.perModel` from authority verdicts.
- `bot/src/provider-auth-read.ts` and `bot/src/session-execution-host.ts` — `providerAuthView` consolidated; both call `canTakeWork` per account per model.
- `bot/src/provider-usage-notice.ts` — notice fields become `perAccount: {verdict}` structures.
- `bot/src/runner-provider-accounts.ts` — `runnerAccountHomes` deleted; callers use `listAccounts`; `accounts.validate` returns new-in-live-root distinctly.
- `bot/src/claude-code.ts` — the parser uses `rate-limit-signals.ts`; terminal line replaced.
- `bot/src/provider-usage.ts` — the thin cache-adapter is deleted; `account-refusal-cache.ts` owns storage; kept functions: `recordUsageSuccess` (adapter calls it), `releaseUsageHeldWork` (release loop callback).
- `bot/src/provider-start-choice.ts` — `newWorkCapacity` computed from `canTakeWork` aggregates.
- `systemd/router-actions.sh` — add `accounts <verb>` namespace.

### 13.3 Delete

- `bot/src/claude-allowance-hold.ts` — temporary Nov 5 hold has passed; inventory confirmed dead code.
- The band-aid additions in the partial PR: `runnerLiveRootMirror`, `namedRunnerAccountHomes`, the branch-local `claudeAccountCachedReset(semantics)` signature — those are subsumed.

## 14. Preserved dated reasons — index

The following reasons (from the inventory doc §3) map to tests. Each test file's top comment quotes the reason verbatim.

- Codex limit outlived account identity (`provider-accounts.ts:16`) → tests in account-refusal-cache + incidents/2026-09-15.
- Mac keychain per-home hash scheme (`provider-accounts.ts:118`) → incidents/2026-09-22-mac-keychain-discovery.
- Mac tejas@chann.app 54% free + signed out (`provider-account-dispatch.ts:158`) → incidents/2026-11-02-mac-signin-wait-read-as-usage.
- hand sign-in as tejas@chann.app displaced his personal account (`provider-account-dispatch.ts:193`) → incidents/2026-10-07-hand-login-displaced-personal.
- A percentage drop cannot identify which window caused refusal (`provider-account-usage.ts:722`) → noted as constraint on `canTakeWork`'s cache retirement: the rule requires reading windows to be all under 100% AND no window's reset to match; this makes the drop meaningful.
- Every lost account on this server traces to such a copy (`provider-accounts.ts:482`) → incidents/2026-10-07-shared-copy.
- Nine inputs refused in 43 seconds (`provider-usage-notice.ts:56`) → incidents/2026-09-22-usage-limit-silent-stop.
- 21% pace notice at 3:10 AM (`provider-usage-forecast.ts:254`) → tests preserve NOTICE_AT_PERCENT = 90 as configuration.
- `accountAvailability` must say per-account resets (`provider-usage-forecast.ts:287`) → incidents/2026-10-09.
- `accountsWithRoom` must include selected (`provider-usage-forecast.ts:326`) → incidents/2026-10-09-selected-excluded.
- synthetic filter origin (`claude-code.ts:313`) → incidents/2026-11-02-fresh-request-failed-instead-of-moving.
- `agentSpoke` filter gates synthetic but not messageParts (`claude-code.ts:316-320`) → §6 explains the F4 fix at that line.
- Terminal decision at line 1549 → tests in rate-limit-signals.test.ts.
- Mac-signin-wait reads usage (`provider-exhaustion-recovery.ts:176`) → incidents/2026-11-02.

The full list is 60+ entries; those live in the inventory doc §3 and each has its mapped test file name.

## 15. Open questions for the user

**Q1. Provider chain default.** A new session has no `provider_chain` set. The research plan says "operator declares the chain". Should Concierge default `[provider]` (no failover, matches today) or `[provider, otherProvider]` where otherProvider is the automatic fallback (rolls back less painfully during outage)? Default proposed: `[provider]`; the operator opts in with `accounts provider-chain`. Alternative: Concierge sets `[claude, codex]` and `[codex, claude]` for coding work at creation, driven by which provider is Automatic.

**Q2. Live-root adoption permission.** When `resolveAccountHome` sees `new-account-in-live-root`, the proposal offers a migration command. Should this happen automatically on next reader cycle (treat the live root as a short-lived staging area), or require the operator to run `accounts adopt-live-root`? The band-aid proposed automatic adoption. The research plan proposed operator-triggered. Default proposed: operator-triggered, because Concierge never silently moves the user's shell login.

**Q3. Codex refusal scope.** Today Codex refuses at account scope (no model). Its App Server reads once at start; if a Codex 429 arrives with an invalid rate-limit payload, the authority has no "fresh" reading to retire from. Is the right rule: Codex's retire-by-reading uses any post-refusal reading (even one that returned `signedOut: true`)? Or must it be a positive reading? Proposed: a post-refusal reading that returns `signedOut: true` does NOT retire — it causes a `credential-expired` repair; only a positive reading retires.

**Q4. "Proven within 10 minutes" window length.** The 10-minute window for `proven-attempt` is drawn from today's `claudeHomeProven` behavior. Do we want a tighter window (5 min) or looser (30 min)? Default proposed: 10 minutes, unchanged. Longer windows let a successful turn authorize a batch of held turns; shorter tightens the room-but-refused override.

**Q5. Where does the parser live for Codex?** The F4 fix is Claude-only because Codex doesn't have a synthetic-vs-structured conflict. Should we still symmetrize by building a Codex `rate-limit-signals` for structured observation, or keep it minimal? Default proposed: minimal — Codex uses the existing `account/rateLimits/read` machinery; no new module for it.

These do not block the build. The build proceeds with the proposed defaults; the questions are flagged so the user can override during review.

## 16. What gets simpler

1. One call (`canTakeWork`) answers dispatch, release, UI, and recovery. The dispatcher stops being a 450-line decision tree.
2. The ambiguity trap is structural impossible — the home resolver dedupes by account, so no user action on the shell can create a duplicate candidate.
3. The user's dashboard and the dispatcher's belief match by construction: the badge is derived from `canTakeWork`, not from raw `/usage`.
4. Operator interventions have CLI commands; no SQL, no file-moves.
5. The synthetic-vs-structured conflict goes from an invisible hazard to a logged, auditable event.
6. Cross-provider failover follows a declared order, not a percentage heuristic.
7. Dead code (`claude-allowance-hold.ts`, scattered branch-local caches) is deleted; the system is smaller than before.

## 17. Appendix — referenced inventory sections

- Twelve-source cross-check: `inv-call-sites.md#twelve-source-cross-check` and the inventory doc §2.
- Dispatch nine gates: `inv-dispatch.md` dispatch-decision section and the inventory doc §5.
- Parser flow and `<synthetic>` filter origin: `inv-parser.md` and the inventory doc §6.
- Call sites to rewrite: `inv-call-sites.md` and the inventory doc §4.
- Operator-command gaps: `inv-cli.md` and the inventory doc §9.
- UI duplication (two `providerAuthView`): `inv-ui.md` and the inventory doc §10.
- Home resolution and F3: `inv-identity.md#home-enumeration` and the inventory doc §7.
