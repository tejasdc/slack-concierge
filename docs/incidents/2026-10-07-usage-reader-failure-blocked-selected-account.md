---
failure: When the usage meter could not read the selected Claude account, work failed as "out of room" although the account was fine.
date: 2026-10-07
fix_commits: [d26272f7]
cause_status: confirmed
---

# A failed usage reading stopped work on an otherwise usable Claude account

## What was seen

Agent work on Tejas's selected Claude account failed with an "out of room" message that carried no reset time,
even though the account's own login in its home was valid and had allowance left.

## Cause

Confirmed from the commit. The usage reader (claude-swap) reads usage with its own copies of each login, not the
login in the account's home. When that read failed or was missing, `chooseClaudeDispatch`
(`provider-account-dispatch.ts`) recorded the account's `problem` and a null used-percent, so the account was
treated as unlaunchable. With no other account launchable, the turn failed as out of room with no reset
instant, because nothing was actually out of room: the reading was unreliable, the account was not.

## Fix

d26272f7: for the selected account that has its own home, a missing usage reading is treated as zero used and
its `problem` is cleared (`trusted`). The turn is simply tried; if the account really is at a limit, Claude
refuses and the refusal returns as the ordinary usage hold with its reset time. Other accounts keep the old
rule. The behavior is recorded in `docs/architecture/PROVIDER-USAGE.md`.

## Acceptance scenario

- **Seed:** two Claude accounts with own homes; the selected one's usage reading fails (reader error or no
  reading) while its home login works.
- **Action:** dispatch a turn to the selected account.
- **Expected:** the turn runs on the selected account instead of failing "out of room". If that account is
  genuinely at its limit, the turn becomes a usage hold carrying the provider's reset time rather than a
  terminal failure.
- **Replayable offline:** yes for the dispatch choice (feed `chooseClaudeDispatch` a usage snapshot with a
  problem on the selected account); the genuine-limit half needs a real provider refusal.
