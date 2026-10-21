---
failure: Two running sessions were told their Claude account was at or above 90% while Accounts showed that account at about 10%.
date: 2026-10-14
fix_commits: [8e0f5950, 8bfafe1e, c5d3e448]
cause_status: confirmed
---

# A running-session warning said Claude was above 90% while Accounts showed 10%

## What was seen

At 3:48:39 PM ET on 2026-10-14 two running Claude sessions (turns 8815 and 8822) received the budget brief "this
Claude provider is at or above 90% of its usable allowance". Tejas saw Accounts showing about 10% for the account they
were running on and asked why, and for one source of truth. Full evidence is in
docs/plans/2026-10-14-account-allowance-authority.md (from the 3:59 PM production backup).

## Cause

Both sessions ran on the personal account; its latest reading was 10% weekly at 3:42:02 (6 m 37 s old). The chann.app
account read 100% weekly at 3:45:19. The old `budgetBriefWithProviderRoom` in `bot/src/provider-start-choice.ts` did
not read the running account at all: it called `newWorkCapacity`, the new-work routing score, whose six-minute
`FRESH_MS` rule dropped the personal reading, leaving chann.app at 100% as the only candidate. That score crossed
`NOTICE_AT_PERCENT`, and the brief printed the fixed phrase "at or above 90%", which was template wording, not a
measurement. The same routing score (which also folds in cached refusals) fed the human 90% warnings, and forecasts
used the scan's batch time rather than each account's provider read time. No provider refusal was needed to produce it.

## Fix

- 8e0f5950: new `measuredBudgetPressure` reads the stored Accounts reading for the account the run is bound to
  (`boundAccount` from `session-execution-host.ts`), and only a fresh window at or above 90% produces a brief. The
  brief names machine, account, window, percentage and observation time. Routing capacity and cached refusals no
  longer create a threshold brief; Codex-delegation advice applies only when the run's account is the selected one.
- 8bfafe1e: human 90% warnings and forecasts use each account's own `readAt`, skip a provider snapshot with a
  problem, and no longer promise an unproven account move.
- c5d3e448: warnings and briefs require that account's provider observation to be at most one minute old
  (`BUDGET_NOTICE_MAX_AGE_MS`), with no fallback to the scan time; dispatch keeps its six-minute rule.
Later commits that day (3f234938 through 9cdcdd33, a2d8d933, 0b580fed) extend source-timed evidence to routing,
Accounts and Codex. They are the wider allowance contract, not this warning's fix.

## Acceptance scenario

- **Seed:** Claude readings: personal 10% weekly read 6 m 37 s ago, chann.app 100% weekly read 3 m 20 s ago; two
  running Claude turns bound to personal; chann.app selected or not.
- **Action:** The usage watch builds running-session briefs and human threshold notices.
- **Expected:** Neither personal session gets a budget brief; no human 90% notice names personal; a brief appears only
  when a reading of the run's own account, at most one minute old, is at least 90%, and it states that account,
  window, percentage and time.
- **Replayable offline:** yes (seed `provider_usage_readings` and execution accounts in a scratch ledger)
