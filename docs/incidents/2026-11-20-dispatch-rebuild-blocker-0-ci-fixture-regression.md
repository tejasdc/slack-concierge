---
failure: CI release check red — inbox-session-pin-fixture's `chooseClaudeDispatch` throws "Every available Claude account is out of room" with a fresh `provider_account_usage` row at 10% weekly.
date: 2026-11-20
fix_commits: [ba71e733]
cause_status: confirmed
---

# "Every available account out of room" with every reading at 10%

## What was seen

CI release check `https://github.com/tejasdc/slack-concierge/actions/runs/44646276119`
failed at `bot/scripts/inbox-session-pin-fixture.ts:87`. The fixture creates three
accounts with `provider_account_usage.windows[Weekly].usedPercent = 10` for all
three, calls `selectClaudeAccount('one', 'one')`, then loops exhausting each.
Iteration 1 called `chooseClaudeDispatch('one', 1, undefined, 'opus[1m]')` and
got `ProviderDispatchError: Every available Claude account is out of room` —
BEFORE the loop had recorded any exhaustion on account 'one'.

## Cause

`canTakeWork` in `bot/src/account-authority.ts` composes a reading view via
`buildReadingView`, which called `accountReadingFresh(provider, usage, accountUsage, now)`.
That helper required a per-account `readAt` field on the account row to return
`fresh=true`. The fixture inserts only `usage.observedAt` (batch time), not a
per-account `readAt`. So:

- `accountReadingAt(accountUsage)` returned `null`.
- `accountReadingFresh(...)` returned `false`.
- Step 3 of `canTakeWork` never engaged (`reading.fresh` was false).
- Step 5 (last-showed-room) was gated on a stale reading being present with a
  valid `readAtMs`; without `readAt`, also skipped.
- Result: verdict fell through to `reason: 'unknown'` / `reason: 'reading-stale'`,
  and the dispatcher threw.

The rebuild's authority was too strict: a reader without per-account `readAt`
(fixtures, older readers, peer copies) was ignored.

## Fix

`buildReadingView` falls back to `usage.observedAt` as a safe lower bound on
every account's read time when per-account `readAt` is missing. The strict
helper still wins when it can decide; only when it refused SOLELY because
readAt was absent do we compute freshness from the batch's observedAt.

## Acceptance scenario

- **Seed:** insert one `provider_account_usage` row with `observedAt` set and
  three accounts each with `windows: [{Weekly, 10%, resetsAt: now+86400s}]`.
  Do NOT set per-account `readAt`.
- **Action:** call `canTakeWork('claude-code', {provider:'claude-code', label:'one'}, 'opus[1m]')`.
- **Expected:** verdict returns `ok: true, reason: 'ready', source.readingUsedPercent: 10`.
- **Replayable offline:** yes — the fixture itself at
  `bot/scripts/inbox-session-pin-fixture.ts` is the replay.
