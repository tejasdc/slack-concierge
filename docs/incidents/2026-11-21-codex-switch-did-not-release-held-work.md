---
failure: Switching the Codex account in the Accounts panel did not release queued Codex work that had been held for the old account's exhausted allowance; Canvas 13 stayed stuck on "No Codex account available on this machine has room now" after the switch.
date: 2026-11-21
fix_commits: []
cause_status: confirmed
---

# Switching the Codex account did not unstick held turns

## What was seen

Tejas's Canvas 13 session (10264) had three queued Codex turns waiting on the agent
badge **Held — No Codex account available on this machine has room now. The earliest
reported reset is November 23 at 1:17 AM ET; Concierge will check again then. Your
message is kept here and will run when an account on this machine is ready.** The
dispatcher was refusing them with:

```
ProviderDispatchError: Usage for tejastej.dc@gmail.com is cached as exhausted until
2026-11-23T06:17:34.000Z. No request was sent, so this input keeps its place and is
tried again at that time. Switching to another account in Provider accounts starts
sending again sooner.
```

Tejas opened the Accounts panel and switched Codex from `tejastej.dc@gmail.com` (his
ChatGPT Pro account, genuinely at 100% weekly used until Nov 23) to `tejas@chann.app`.
The daemon's `/root/.codex/auth.json` was rewritten to the new login, but Canvas 13
stayed held for several minutes until an operator cleared the usage cache and the
`dispatch_hold='usage'` by hand.

Tejas: "I did change the provider in the menu, but really I shouldn't have to, but
its still not working."

## Cause

`putCodexAccountInUse` in `bot/src/session-execution-host.ts` triggers an async
`scheduleProviderAccountUsageRefresh()` after a successful switch but never calls
`releaseUsageHeldWork('codex', ...)` directly. The release relies on the next usage
probe seeing the new active account with room — line 753 of `provider-account-usage.ts`:

```ts
if(provider==='codex'&&activeHasRoom&&!cachedUsageLimit(usageAttempt('codex')))
  releaseUsageHeldWork('codex','usable_account_observed');
```

`activeHasRoom` is computed from the account the runner identifies as `current`. On
2026-11-21 the runner's `accounts.identity` call kept returning the old
`tejastej.dc@gmail.com` for several minutes after the switch, and the probe reported
only that one account with `current:false` and `usedPercent:100`. `activeHasRoom`
stayed false, `releaseUsageHeldWork` never fired, and the queued turns' `dispatch_hold='usage'`
plus `dispatch_next_attempt_ms` far in the future kept them parked until the Nov 23
reset instead of running on the newly-activated clean account.

The queued turns were not bound to a specific account — their `providerAccount` in
session metadata was empty — so there was no reason to hold them for the old
account's reset once the daemon had moved. The switch was already sufficient proof
that the operator wants new work to run on the new login.

## Fix

In both branches of `putCodexAccountInUse` (runner and local), call
`releaseUsageHeldWork('codex', 'owner_switch')` as soon as the activation reports
`applied`. `releaseUsageHeldWork` → `releaseCodexUnboundUsageHeldWork` →
`releaseScheduledProviderRetries('codex', true)` moves every queued Codex turn whose
`dispatch_hold='usage'` and `dispatch_failure_class='backoff'` to the paced release
hold with `dispatch_next_attempt_ms=0`, so they retry on the new login within the
next pace window. If the new account is also spent, the turn re-fails and re-holds
with its own reset time — nothing is lost. If the switch was premature (activation
not `applied`), nothing is released.

The release does not touch banked work (`saved_kind='banked'`) or scheduled work
explicitly saved for a specific account: those were kept for the old account's
window on purpose and must not be silently moved onto a different login.

## Acceptance scenario

- **Seed:** A Codex session has a queued turn whose dispatch previously failed with a
  cached refusal of the old Codex account (`dispatch_hold='usage'`,
  `dispatch_failure_class='backoff'`, `dispatch_next_attempt_ms` in the future).
  The session's `providerAccount` metadata is empty.
- **Action:** `putCodexAccountInUse(<path to the new account's `auth.json`>)` on the
  session execution host; its runner path returns `activation.status='applied'`.
- **Expected:** Within the same turn, the queued row's `dispatch_hold` becomes
  `'release_pace'` and `dispatch_next_attempt_ms` becomes `0`. The release emits
  `provider_usage_hold_released released_by:owner_switch`.
- **Replayable offline:** yes (integration-shaped test in
  `bot/tests/incidents/2026-11-21-codex-switch-releases-held-work.test.ts`).
