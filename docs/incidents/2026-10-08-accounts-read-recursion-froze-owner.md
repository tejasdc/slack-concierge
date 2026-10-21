---
failure: Opening Accounts, or anything that checked which Claude account agents ran on, froze Concierge for up to two and a half minutes at a time for about seven hours, and nobody was told.
date: 2026-10-08
fix_commits: [b88a4f7e, b81b99dd, 70207e58]
cause_status: confirmed
---

# Accounts reads froze Concierge for minutes while the log filled unread

## What was seen

From 2026-10-07 22:26 EDT to 2026-10-08 01:40 EDT the owner loop froze for 7–144 s at a time; pages and
messages stalled with it. About 1,000 `owner_event_loop_lag` lines an hour sat in the journal and nothing
read them. One `GET /auth/providers` took 53.7 s; owner lag equalled each read's duration (7.1–7.4 s, back
to back for 144 s at 05:17 UTC). No error was logged.

## Cause

Confirmed by strace and the fix (b88a4f7e). A recursion cycle: `listProfiles` → `profileAccountEmail` →
`recoverProfileAccountEmail` (for an account with no recorded name) → `providerAccountUsage` →
`withAgentsAccountCurrent` (added in 70ebafc) → `claudeRunsFromOwnHomes` → `listProfiles`, until the stack
overflowed. `providerAccountUsage`'s `catch` turned the overflow into `null`, so it looked like a slow read
rather than an error. One read did ~3,250 listings of `~/.claude-accounts` and ~7,500 reads of each account
file, all synchronous on the owner loop. Detection failed separately: loop-lag events were only logged, never
counted or surfaced.

## Fix

- b88a4f7e (`provider-accounts.ts`, `provider-account-usage.ts`, `provider-account-dispatch.ts`): email recovery
  reads the stored account names (`storedProviderAccountLabels`) instead of the view derived from the current
  account; `claudeRunsFromOwnHomes` counts kept accounts (`keptProfileCount`) instead of reading each one.
  On a ledger copy `listProfiles(claude)` went 5,220 ms → 3.9 ms, `providerAccountUsage` 3,706 ms → 0.7 ms.
- b81b99dd: `owner-responsiveness.ts` counts lag as it happens and files one provider-free notice for a minute
  of freezing in five or one 30 s freeze (later routed to the repair agent by ad009b70); `providerAccountUsage`
  logs `provider_account_usage_unreadable` instead of returning null silently.
- 70207e58: a slow Accounts read logs each step's duration.

## Acceptance scenario

- **Seed:** two or more Claude account homes, at least one without a recorded `.account-email`; the account
  selected for agents is an extra home.
- **Action:** request the Accounts provider list (`GET /auth/providers`) repeatedly.
- **Expected:** each read returns in milliseconds, no recursion (bounded directory listings per read), no
  `owner_event_loop_lag` over 200 ms; if a usage read throws, `provider_account_usage_unreadable` is logged.
- **Replayable offline:** yes (scratch account homes and a scratch ledger)
