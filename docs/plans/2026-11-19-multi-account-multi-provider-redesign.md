# Multi-account, multi-provider management: a redesign plan

Author: research fork, 2026-11-19
Status: proposal for direction — no code changed yet
Trigger: four stacked failures in one hour (see timeline). Tejas: "this has been too buggy."

## Incident timeline — 2026-11-19

| Time (ET) | Event | Observed effect |
| --- | --- | --- |
| 11:06 | Bot's Opus 5.5 turn on `tejas@chann.app` 429s; refusal cached under scope `813e…:claude-opus-5-5`, `resetAt` Nov 22 22:00 ET | Normal and correct |
| 11:07 | Bot's Opus 5.5 turn on `hey@tejas.nyc` 429s with the **same** Nov 22 reset; cached under `81c6…:claude-opus-5-5` | Phantom cache — hey@tejas.nyc's own weekly resets Nov 19 20:00 ET, not Nov 22 |
| 12:07 | Tejas sends "clear my account for demo" to Essos iMessage agent | Queued; dispatch sees cached Opus refusal on both accounts; status reads "Waiting for provider usage to free up · until 9:59 PM" (chann.app's reset) |
| 12:37 | Tejas sends "walk me through the architecture…" | Queues behind 12:07 message, same hold |
| 12:44 | Fresh `/usage` reading shows `hey@tejas.nyc` 39% weekly used, "room remains" | UI contradicts cache; hold stays because `claudeAccountCachedReset(account, null)` matches any model's cached refusal and `activeHasRoom` gates on `!claudeAccountCachedReset(current, null)` |
| 12:52 | Claude dashboard panel screenshot shows hey@tejas.nyc "in use" with Opus "room remains" while queue says "no account has room" | The split between `/usage` reading (UI) and 429 refusal cache (dispatch) becomes user-visible contradiction |
| 12:56 | First manual release of held turns — bot retries, hits same 429, re-caches | Confirms refusal is coming back from Anthropic at bot's call path |
| 13:22 | Direct manual `claude -p --model claude-opus-5-5 --resume 93bba235 --output-format stream-json --verbose` from same `CLAUDE_CONFIG_DIR` succeeds; `rate_limit_event` returns `status:"allowed", rateLimitType:"seven_day", utilization:0.39, resetsAt:` Nov 19 20:00 ET | Proves the account can run Opus right now; the bot's path must differ in input shape or in something after init |
| 13:34 | Tejas runs `claude /login` in CLI → sign-in lands in `/root/.claude/.credentials.json` (default home) as `hey@tejas.nyc` | `/root/.claude-accounts/hey-tejas-nyc/.credentials.json` is still signed in too |
| 13:37 | New release (065c9474) deployed meanwhile; new dispatch now calls `accounts.validate` which finds **two** homes for `hey@tejas.nyc` → `{ available:false, resolution:"ambiguous" }` | Every Claude turn refused with `Runner ax41 cannot resolve selected Claude account hey@tejas.nyc (ambiguous); the turn remains held.` |

At the end of the hour: zero turns dispatchable to Claude, the one account that actually has room is locked out by the ambiguity guard the runner just gained, the user has read on their screen that there is 39% room, and the bot has re-cached the same phantom "weekly limit Nov 22" twice.

## Current state: how account facts are tracked

### Discovery and identity

Both providers have **three overlapping sources of identity** per account:

1. **Live root home** — `~/.claude/` or `~/.codex/`. The shell's default, the CLI's default. Whatever was last `/login`'d there owns it. `provider-accounts.ts:localDefaultClaudeAccount` reads it; `runner-provider-accounts.ts:liveRoot` and `claudeAccount(liveRoot)` include it in the home enumeration.
2. **Per-account home** — `~/.claude-accounts/<folder>/` or `~/.codex-accounts/<folder>/`. The convention Concierge created so one account's limit can't poison another's dispatch (comment at `provider-accounts.ts:16-20`: "a Codex limit was cached under the literal scope 'account' with no account identity, so a limit outlived the account it belonged to"). Each folder holds `.credentials.json`, `.account-email`, and (for Claude) symlinks for the shared non-per-login entries (`claude-home-entries.ts`).
3. **Platform keychain** (Mac only) — `Claude Code-credentials` for `~/.claude/`, `Claude Code-credentials-<first-8-hex-of-sha256-of-home-path>` for `~/.claude-accounts/*/`. The 2026-09-22 comment in `provider-accounts.ts:118` records the Mac discovery. `claudeKeychainMayHoldLogin` is the presence check; `claudeKeychainOauth` returns the actual token.

Codex has a fourth: the shared App Server reads `auth.json` **once at start** and keeps the token in memory (`provider-accounts.ts:170`). So file and daemon can disagree.

`AccountIdentityProvider` is `"claude-code" | "codex" | "antigravity"`. Google/Antigravity only lives in the Gemini CLI's own keyring; Concierge reads its usage through `/usage` and never sees its token.

### How "current" is picked per call

| Call site | How it chooses | Problem |
| --- | --- | --- |
| `currentAccount(provider)` in `provider-accounts.ts:208` | Runner identity if a runner is configured (set by `setRunnerAccountInUse` after usage read); else reads the live-root credential file; else `claudeSignIn`/`codexSignIn` memory from last `claude auth status`. | Three fallback layers; each has its own moment to disagree with `/usage` and with the actual turn path. |
| `chooseClaudeDispatch` in `provider-account-dispatch.ts:319` | 70 lines of layered rules: provenWaitingTurns proof, selected home with no reading, selected account from selection table, warm cache, `chooseAccountForTurn`, "lastShowedRoom", "unreadable" fallback, give up. Each gate checks `claudeAccountCachedReset(account, model)` independently. | Any of six gates can send a turn somewhere different. Reproducing a decision requires walking the whole ladder. |
| `agent-claude-launch.ts:useConciergeChoice` | Asks `/sessions/v1/auth/claude-launch-choice` for `{account, home}`, sets `CLAUDE_CONFIG_DIR`, then runs `claude auth status --json` to verify it comes back as the selected email. | The auth-status verification is good; but the home it uses was already derived upstream. Any upstream ambiguity (today's case) refuses before this runs. |
| `accounts.validate` RPC in `runner-provider-accounts.ts:831` | Filters `runnerAccountHomes` by `home.account === params.account`; requires exactly one match. | **This was today's trap.** It treats the live root and the per-account home as independent candidates and refuses when both are the same account. |

### How many places track the same fact

Take the fact "hey@tejas.nyc has room for Opus work right now":

| Place | What it says | Updated by |
| --- | --- | --- |
| `provider_usage_cache.limits_json[81c6…:claude-opus-5-5]` | `{resetAt: Nov 22, observedAt: 11:07}` | A 429 from a bot-launched Claude turn |
| `provider_account_usage.usage_json.accounts[hey@tejas.nyc].windows[Weekly]` | `{usedPercent: 39, resetsAt: Nov 19 20:00}` | `provider-account-usage.ts` reading loop, every ~12 min |
| `provider_account_usage.usage_json.accounts[hey@tejas.nyc].signedOut` | `undefined` | Same loop; `true` only if provider returned a sign-in refusal |
| `provider_account_selection` row | `{profile_id: runner-81c6…, account_label: hey@tejas.nyc, revision: 31}` | Explicit account switches from Accounts UI |
| `claude_home_proof` row | `{home: /root/.claude-accounts/hey-tejas-nyc, proven_at_ms: …}` | `markClaudeHomeVerified` after a successful real turn or background `claudeAccountWorks` probe |
| In-memory `provenHomes: Set<string>` | Same home | Same places, plus `claudeHomeProven(home)` read-through |
| `.account-email` file | `hey@tejas.nyc` | Written at sign-in file-move (`runner-provider-accounts.ts:334`) |
| `oauthAccount.emailAddress` in each home's `.claude.json` | `hey@tejas.nyc` | Claude Code CLI writes it on sign-in |
| `~/.claude.json` (default) `oauthAccount.emailAddress` | Whatever last `/login` wrote | Hand sign-in in default home (today's trap) |
| `claudeSignIn` module variable | Last `claude auth status --json` result for the default home | `refreshClaudeAccount()` on a timer |
| `runnerIdentity` map | Set once a runner is configured | `setRunnerAccountInUse` after usage read |
| Mac keychain items (per-home) | Token blob | Mac-only hand sign-in; `claudeKeychainMayHoldLogin` presence check |

**Twelve places can disagree.** The Nov 2 comment at `provider-account-dispatch.ts:158` already records one such divergence ("the Mac's tejas@chann.app read 54% free while its home was signed out, and the hold notice promised work would 'move to it by itself'").

### How refusals cache and how they retire

- `recordUsageExhaustion(attempt, resetAt)` in `provider-usage.ts:106` writes `{resetAt, observedAt, revision}` keyed by `scope = <acctHash>:<canonicalModel>`. Opus 1M collapses to standard Opus (`aliases.ts:483-493` — the 2026-11-02/03 note: Opus 1M shares the Opus allowance).
- `cachedUsageLimit(attempt)` returns the limit if `generation` matches and `resetAt > now`.
- Retirement paths:
  - `recordUsageSuccess` — a successful call on the exact `scope`.
  - Reset time passes (`prune`).
  - `clearProviderUsage(provider)` — bumps generation, wipes everything (operator-only, no CLI handle).
  - `clearCodexAccountUsage(accountId, verifiedReadStartedAtMs)` — Codex-only account scope.
  - `retireCodexRefusalSupersededByReading` — Codex-only (`provider-usage.ts:188`); a reading showing all windows <100% **with no window whose reset matches the cached refusal** retires it. There is **no Claude equivalent**. The 2026-11-06 comment explains why for Codex. For Claude, the comment at `provider-account-usage.ts:722-724` says "A percentage drop cannot identify which window caused a model-specific refusal. The exact model's success, a manual clear, or its stated reset retires that cache."
- The dispatch-time gate `claudeAccountCachedReset(account, model?)` (`provider-usage.ts:72`) — critically — returns the **max** reset from **any scope prefixed by the account hash** when `model` is null. So an Opus-only cache poisons every model-agnostic check (`activeHasRoom`, `claudeHeldWorkCanRun`, `chooseClaudeDispatch` when called without a model).

### Fallback within and across accounts

- **Within one account, model fallback**: `claudeUsageFallbackModels(model)` (`aliases.ts:488`) returns the models after `model` in the chain `[fable, opus, sonnet, haiku]`. `startUsageFallback` in `claude-code.ts:942` issues a `set_model` control request on the live Claude Code subprocess and retries; the fallback loop is single-account, same subprocess.
- **Across accounts**: handled a level up. `chooseClaudeDispatch` picks an account per turn; a usage refusal re-queues (`dispatch_hold='usage'`, `dispatch_failure_class='backoff'`); the next dispatch attempt re-enters `chooseClaudeDispatch` and may pick a different one, **provided its model-specific cache didn't also get poisoned on the generic check**.
- **Across providers**: `recoverExhaustedClaudeWork` in `provider-exhaustion-recovery.ts:171` moves held Claude turns to Codex, but **only when `newWorkCapacity('claude-code')?.used >= 100 AND newWorkCapacity('codex')?.used < 100`**. `newWorkCapacity` reads `/usage` numbers, not caches. In today's case `hey@tejas.nyc` read 39% so Claude didn't look exhausted system-wide and nothing moved.

### Bot's call path vs. manual `-p` path

Today's "bot keeps getting 429, manual call succeeds" puzzle. Key differences the fork observed:

| Aspect | Manual `-p` | Bot's turn |
| --- | --- | --- |
| Input format | Argv prompt | `--input-format stream-json` piped via stdin |
| Session UUID | Same (`--resume 93bba235`) | Same |
| Model | `claude-opus-5-5` | `claude-opus-5-5` |
| Settings | None | `--settings <CLAUDE_AGENT_HOOK_SETTINGS>` injecting Stop + PreToolUse hooks (`claude-code.ts:488-497`) |
| MCP config | None | `--mcp-config <sharedPlaywrightMcpConfig>` when available |
| Permissions | Default | `--dangerously-skip-permissions` (root on server) |
| Append system prompt | Default | Potentially `--append-system-prompt` |

Both calls land `{type:"rate_limit_event", rate_limit_info}` in the stream (the manual call proved it). The bot's parser at `claude-code.ts:1146` reads only `event.rate_limit_info?.status === "rejected"` to set `usageRejected`. But at `claude-code.ts:1549`, the terminal decision is `usageRejected || isClaudeUsageExhaustion(parsed.text)`. **`parsed.text` includes the `<synthetic>` "You've hit your weekly limit · resets Nov 22" string** (the synthetic-filter at `claude-code.ts:316` only stops it from counting as "agent spoke"; the text is still concatenated into `messageParts` at line 318). So even when the structured `rate_limit_event` says `status:"allowed"`, the synthetic text can and does mark the turn `usageExhausted` → cache a Nov 22 refusal.

The reset time Claude Code CLI prints inside the synthetic message ("Nov 22, 10pm") is a different value from the structured `resetsAt`, and the bot never compares them. `recordUsageExhaustion(attempt, usageResetAt)` is called with `usageResetAt` (from `rate_limit_event`) if present, else `null`. In today's case `rate_limit_event.status` was "rejected" at the bot's call for reasons the fork could not reproduce locally, so `usageResetAt` was a real Nov 22 value. But the broader hazard — synthetic string without a structured event — is live.

## Failure modes catalogued

| # | Failure mode | Current behavior | Why it exists (comment date) | Cost today |
| --- | --- | --- | --- | --- |
| F1 | Model-specific cache poisons model-agnostic release check | `claudeAccountCachedReset(account, null)` returns a positive number if ANY scope under that account's prefix has a future `resetAt` | Written before model-aware callers existed; 2026-11-02 Opus-1M-vs-Opus noted but not fully generalized | hey@tejas.nyc's Opus cache blocked Sonnet, Haiku, and "unknown model" release decisions despite abundant 7-day room |
| F2 | No Claude equivalent of `retireCodexRefusalSupersededByReading` | A fresh reading showing room never retires a Claude model-specific cache | 2026-11-06 Codex rule explicitly chose model-specific success as the only Claude retirement | A reading contradicting the cache sits visible on the UI; dispatch keeps waiting |
| F3 | `runnerAccountHomes` enumerates live root + each per-account folder as independent candidates | A hand `claude /login` into the default home creates a duplicate entry; `accounts.validate` returns `ambiguous` | Written to support both legacy single-home installs and multi-home installs; same code handles both | Today's manual sign-in locked out every Claude turn across the whole bot |
| F4 | Synthetic CLI text can override structured `rate_limit_event` | `parsed.text` contains the synthetic string; `isClaudeUsageExhaustion(parsed.text)` triggers a cached refusal even when `rate_limit_event.status:"allowed"` arrived in the same stream | Synthetic-filter was added for a different bug (2026-11-02, "fresh request failed instead of moving to the other account") — the filter removed `agentSpoke` but kept the text in the buffer | Observed today: bot cached Nov 22 refusals that the structured event contradicted; wasted 7+ real API calls before the manual intervention |
| F5 | Stale `/usage` reading never auto-retires its reading-level `problem` | `tejastej.dc@gmail.com` reads "Showing the last reading" from Oct 23; cached refusals under that account stay cacheable without the reading contradicting them | Reader stores `problem` on fresh read; stale reading just keeps the old copy with the same `problem` | tejastej.dc was unavailable as a fallback for a full month, invisibly |
| F6 | Dispatch model-fallback is within one subprocess only | Fallback goes Fable→Opus→Sonnet→Haiku on the same account's live `claude` process; on failure of every model, the whole turn is re-queued | Convenient: `set_model` control request avoids a restart | When the whole process is being refused (today's phantom), fallback exhausts all models and re-queues with the worst reason |
| F7 | Cross-provider automatic failover requires `newWorkCapacity.used >= 100` | `recoverExhaustedClaudeWork` uses `/usage` numbers only, not cached refusals | 2026-10-07/11-02 comments: percentages beat caches | When reality is "all models refused on all Claude accounts" but `/usage` shows one account at 39%, no transfer happens |
| F8 | Three identity caches with independent refresh | Runner identity, module-level `claudeSignIn`/`codexSignIn`, file-based `currentAccount` memo (`mtime:size` key) | Written progressively as corner cases appeared | Any inconsistency is user-visible once per cache's refresh interval |
| F9 | Home-proof vs. selection vs. `/usage` fresh-current can all diverge | Nov 2 comment at `provider-account-dispatch.ts:158` names this | Each system solved a local problem | Visible today as "in use" badge (selection) alongside "room remains" (reading) alongside "cached refused" (cache) alongside "ambiguous" (validator) |
| F10 | `clearProviderUsage` has no CLI handle | Only directly callable from code; today's stop-the-bleed had to write SQL | Written as a last-resort; comment line is "No cache command is involved" (`provider-usage.ts:83`) — but that's about not **needing** one, not forbidding it | The exact intervention today's investigation needed had no supported entrance |

## Redesign proposal

### Core idea — one `AccountRow` per `(provider, account)` pair, four computed statuses

Collapse the twelve-source identity sprawl into one source and three computed views.

**`AccountRow`**, materialized in SQLite `provider_accounts` (new table), one row per `(provider, account_label)`:

```
provider          'claude-code' | 'codex' | 'antigravity' | 'chatgpt'
account_label     email (hey@tejas.nyc, tejas@chann.app, …) — always the user-visible identity
account_id        provider's own id (Claude accountUuid, Codex account_id, Google email, ChatGPT subject)
canonical_home    one path — see "Home resolution" below — or NULL for keychain-backed/daemon-backed
credential_ok     derived view: file+keychain says "valid, not sign-out"
credential_expires_at  from refresh_token_expires_at (Claude) or auth.json (Codex) or Mac keychain probe
selected          boolean — the one the operator picked for dispatch
runner_bound      the runner this account lives on, if any (ax41, mac, …)
```

### Home resolution — one path per account, never two

**Invariant**: for any `(provider, account)`, the system holds **at most one** home that will be used to launch work. If the live root happens to hold a login that resolves to the same account, it is **not** a second candidate — it is a mirror, and the per-account home is canonical.

Concrete change: `runnerAccountHomes` becomes a reducer, not a list:

```ts
// pseudo
for each candidate home in [live_root, ...per_account_folders]:
  resolve its (account_id, account_label)
  put into Map<account_label, home>, preferring per-account folder over live_root

return [{account, home}] for every unique account in the map
```

`accounts.validate` then returns `available:true, resolution:"unique"` whenever the Map holds a `hey@tejas.nyc` entry, regardless of whether live root also happens to be signed into it.

Side rule: on a hand `claude /login` in the live root that resolves to an account already held in a per-account folder, the runner **notices on next validate** and writes one `provider_home_duplicate_live_root` event; the live root stays as it is (it's the user's shell), but it is never a candidate for dispatch. On a hand sign-in that resolves to a *new* account not held in any folder, offer a one-command migration (`scripts/claude-adopt-live-root --to <folder>`) that moves the credential into the canonical folder and empties the live root.

Expected effect on today's incident: F3 impossible. The manual `/login` would not have broken dispatch.

### A single authority: `canTakeWork(provider, account, model, now) → {ok, reason, clearsAt}`

Replace the scattered gates (`accountCanTakeWork`, `claudeAccountCachedReset`, `hasActiveFullAllowanceWindow`, `claudeAccountLaunchableHere`, `claudeAccountWithRoomBesides`, `claudeHeldWorkCanRun`, `claudeEveryAccountClearsAt`, dispatch inline checks) with **one** function that reconciles everything:

```
canTakeWork(provider, account, model, now):
  home = resolveHome(provider, account)
  if !home: return {ok:false, reason:'no-home', clearsAt:null}
  if !credentialOk(home): return {ok:false, reason:'signed-out', clearsAt:null}
  reading = latestReading(provider, account)
  cache   = cachedRefusal(provider, account, model)  // model-SPECIFIC when model set; model-agnostic ONLY when operator explicitly asked "any"

  // Rule A — cache wins over reading if its reset is specific to this model
  if cache && cache.resetAt > now:
     if reading && readingContradictsCache(reading, cache, model):
        retire(cache); // F2 applied to Claude
     else
        return {ok:false, reason:'cached-refusal', clearsAt:cache.resetAt}

  // Rule B — reading decides only if fresh and complete
  if reading && reading.fresh && accountCanTakeWork(reading, model):
     return {ok:true, reason:'reading-room', clearsAt:null}

  // Rule C — selection+recent-proof grants one attempt
  if homeProven(home, within:10min) && !hasActiveFullAllowanceWindow(reading, model):
     return {ok:true, reason:'proven-attempt', clearsAt:null}

  // Rule D — stale reading with no refusal → one attempt (lastShowedRoom equivalent)
  if reading && !reading.fresh && lastGoodReadingShowedRoom(reading, model):
     return {ok:true, reason:'last-showed-room', clearsAt:null}

  return {ok:false, reason:'exhausted', clearsAt:earliestKnownResetForAccount(reading, cache)}
```

The point is the **ordering** and the **model specificity**:

- Model specificity fixes F1. `canTakeWork(…, 'claude-sonnet-5-5', …)` ignores Opus's cache.
- Rule-A contradiction fixes F2 for Claude. A fresh reading showing a Weekly window at 39% with reset Nov 19 contradicts a cached refusal claiming reset Nov 22 (the dates disagree and the fresh reading shows room). The existing codex rule becomes general: **a fresh reading with every included window <100% and no window's reset matching the cache retires the cache**.
- Rule-D makes the "unreadable but launchable" path explicit instead of buried in `chooseClaudeDispatch`.

Every current caller (`chooseClaudeDispatch`, dispatch-time checks, release gates, UI "has room" badges) calls `canTakeWork`. Multi-rule code vanishes.

### Reconciling `rate_limit_event` with synthetic text

Rule: **the structured `rate_limit_event` is authoritative when present in the turn's stream. Synthetic text alone is a signal only when no structured event arrived.**

Concrete: track two flags per turn — `sawStructuredAllowed`, `sawStructuredRejected`. At turn-end:

```
if sawStructuredRejected: cache the refusal (with structured resetsAt)
else if sawStructuredAllowed: NEVER cache a refusal from this turn, regardless of synthetic text
else if synthetic text matches isClaudeUsageExhaustion: cache with no resetAt (nonblocking tombstone)
```

Why: Anthropic's stream today can hold both an "allowed" rate_limit_event (the one `-p "say ok"` produced in our investigation) **and** a synthetic string left over from the CLI's local notice renderer. Trusting the synthetic in the face of an explicit structured "allowed" is the bug. The 2026-11-02 incident the synthetic filter addressed was about `agentSpoke`, not about rate-limit interpretation — that one fix accidentally blessed the synthetic text for a job it should never have.

Fixes F4. Logs a `claude_synthetic_overridden_by_structured_event` when the two conflict so we can measure how often the CLI emits them together.

### One-source-of-truth for the UI "has room" badge

The sign-in/usage panel reads from `storedUsage(provider).accounts[i].windows[Weekly].usedPercent`. Replace this at the UI boundary with a single `accountStatus(provider, account) → { badge: 'ready' | 'in-use' | 'refused' | 'signed-out' | 'stale', explain: '…' }` that calls `canTakeWork` for every supported model and reports the **most restrictive** answer.

Then the panel says one of:

- "Opus exhausted · Sonnet available · resets Nov 22" — when cache differentiates
- "Reading shows 39% weekly used and Nov 19 reset, but Claude refused Opus with Nov 22 cache — investigating" — explicit contradiction notice
- "Signed out on this machine" — single clear state
- "Reading stale since Oct 23 — Accounts cannot confirm current state" — F5 made visible

Fixes F9 — the user never sees "room remains" next to "no account has room" again.

### Provider fallback — a declared order

Make the provider preference explicit per-session and reuse it as a fallback order:

```
session.provider_chain = ['claude-code', 'codex', 'chatgpt']  // or whatever the operator chose
```

When every account on the first provider returns `ok:false, reason: 'exhausted'|'cached-refusal'` from `canTakeWork`, transfer the held work to the next provider. Today's `recoverExhaustedClaudeWork` gate (`claude.used>=100 && codex.used<100`) is replaced by: "every account on the first provider returned `ok:false` with a `clearsAt` later than the next provider's best `clearsAt`". The `/usage` percentage stops being the dispatcher's source of truth.

Covers F6 and F7. Keeps the model fallback within a provider; adds the provider fallback across them.

### Keep `release`, remove hidden-state surprises

- `clearProviderUsage(provider)` gets a CLI handle: `router-actions.sh sessions usage-clear <provider> [--account <label>] [--model <alias>]`. Clears only the targeted scope(s) by default; clears everything with `--all`. Fixes F10 — today's intervention needed root SQL; an operator should not need SQL for this.
- `invalidateStaleReadings(provider, account, olderThan)` — if a stored reading's `readAt` is older than one week AND problem says "could not be read", drop it to null so UI stops showing stale bars. The reader will re-fetch on next cycle. Fixes F5.

## File-by-file change list

| File | Change | Simplification |
| --- | --- | --- |
| `bot/src/runner-provider-accounts.ts` | `runnerAccountHomes` deduplicates by `(account_label)`, preferring per-account folder over live root; `accounts.validate` becomes a boolean "does that single home exist"; add `accounts.liveRootDuplicate` RPC for reporting | Removes "ambiguous" as a dispatch-refusal reason entirely |
| `bot/src/provider-usage.ts` | Add `retireClaudeRefusalSupersededByReading` mirroring Codex's; export `canTakeWork` composite; expose `clearProviderUsageScoped(provider, account?, model?)` | Removes `claudeAccountCachedReset`'s dual role (model-known vs. model-unknown) — unknown-model becomes an explicit "any of these models" query |
| `bot/src/provider-account-dispatch.ts` | `chooseClaudeDispatch` becomes a ranker over `rooms.filter(r => canTakeWork(…r…).ok)`; the six-gate ladder collapses to sort+pick | ~200 lines → ~40 lines; selection rule explainable in one paragraph |
| `bot/src/provider-account-usage.ts` | Release loop at line 719-739 calls `canTakeWork(provider, current, null)` once; the inline guards disappear; `releaseUsageContinuationHolds`, `releaseUsageHeldWork`, `moveUsageHoldsEarlier` are the same three primitives but fire based on the one authority | Removes the "percentage drop cannot identify which window" comment's weight; it's still true, but `canTakeWork` handles it per-model |
| `bot/src/claude-code.ts` | Parser tracks `sawStructuredAllowed`/`sawStructuredRejected`; terminal decision at line 1549 becomes `usageExhausted = sawStructuredRejected || (!sawStructuredAllowed && syntheticExhausted)` | One-line protection against synthetic overriding structured truth |
| `bot/src/provider-exhaustion-recovery.ts` | `recoverExhaustedClaudeWork` gates on "every account returns `canTakeWork:false`" rather than `newWorkCapacity.used >= 100` | Uses the right signal; fixes the "/usage says 39% but reality is blocked" miss |
| `bot/src/provider-accounts.ts` | `currentAccount` stays as runner-identity-first (no change); `claudeSignIn`/`codexSignIn` become private-to-the-reader and the `currentAccount` fallbacks are deleted; other callers use the composite `canTakeWork` | Removes three cache tiers down to one |
| `systemd/router-actions.sh` + `bot/src/routed-request-api.ts` | Add `sessions usage-clear`, `sessions home-adopt-live-root` | CLI entrances for the two operator interventions that today required SQL and file-moves |
| `docs/architecture/PROVIDER-USAGE.md` | Rewrite the "retirement" and "scope" sections; delete the "percentage drop cannot identify" paragraph as the general rule (keep it as a model-ambiguity note under `canTakeWork`) | One document explains the whole model |

Preserved quoted reasons (from code comments) that `canTakeWork` must keep honoring:

- "a Codex limit outlived the account it belonged to and refused every dispatch locally" (`provider-accounts.ts:16`)
- "the Mac's tejas@chann.app read 54% free while its home was signed out" (`provider-account-dispatch.ts:158`)
- "a hand sign-in as tejas@chann.app replaced his personal account that way, and his personal account dropped out of agents' work with nothing said" (`provider-account-dispatch.ts:193`)
- "A percentage drop cannot identify which window caused a model-specific refusal" (`provider-account-usage.ts:722`) — preserved as a constraint of `canTakeWork`, not as an argument against retirement
- "every lost account on this server traces to such a copy" (`provider-accounts.ts:482`) — the one-home invariant stays

## What gets simpler

1. One call (`canTakeWork`) answers dispatch, release, UI, and recovery. The dispatcher stops being a 450-line decision tree.
2. The ambiguity trap is structural impossible — the home resolver dedupes by account, so no user action on the shell can create a duplicate candidate.
3. The user's dashboard and the dispatcher's belief match by construction: the badge is derived from `canTakeWork`, not from raw `/usage`.
4. Operator interventions (clearing a specific cache, adopting a live-root login into the canonical home) have CLI commands instead of being a file-move exercise.
5. The synthetic-vs-structured conflict goes from an invisible hazard to a logged, auditable event.

## Known unknowns to resolve next

- **Why 13:22 manual `-p` succeeded and 13:28 bot `--input-format stream-json` failed with the same credentials, same session, same model.** The fork did not reproduce the difference. Candidates: (a) the bot's turn attaches `--append-system-prompt` or `--settings` that triggers Anthropic's prompt-injection rate limiter; (b) the stream-json input shape includes a cached conversation prefix whose 243,135 cache-creation tokens hit a different limit; (c) Anthropic 429s on burst-rate when the bot's reader runs usage checks concurrently. Needs a reproducing harness that records both the exact Anthropic request headers and the full `rate_limit_event` payload.
- Whether Opus 1M truly shares Opus 5.5's weekly bucket at Anthropic (the 2026-11-02 comment is the only evidence; worth confirming with an Anthropic API inspector).
- Whether `hasExtraUsageEnabled=false` + `cachedExtraUsageDisabledReason=org_level_disabled` interacts with the 7-day budget in a way that surfaces only on high-cache-creation requests (hey@tejas.nyc has both flags).

---

## Top three findings (one paragraph)

The twelve places that independently track "is this account usable right now" guarantee the user will see contradictions like today's — the fix is to funnel every caller through one `canTakeWork(provider, account, model, now)` authority that orders cache, reading, proof, and sign-in deterministically and that treats model-specific refusals as model-specific (fixing F1 and F2, which together caused the stuck Opus hold and the "39% room but no dispatch" contradiction). The ambiguity trap F3 is a resolver bug, not a user error — `runnerAccountHomes` should dedupe candidates by `account_label` with per-account folder beating live root, so a hand `claude /login` can never turn into a dispatch-wide outage. And the synthetic-vs-structured race F4 is a one-line authority rule — trust `rate_limit_event.status` over `<synthetic>` text — plus a logged conflict event so we learn how often Anthropic's CLI emits both.

Doc path: `/Users/tejasdc/workspace/slack-concierge/docs/plans/2026-11-19-multi-account-multi-provider-redesign.md`.
