---
failure: The Inbox kept running on a Claude account whose weekly allowance was nearly spent after the other account had refilled.
date: 2026-10-10
fix_commits: [c39ef67b, 62c9f739]
cause_status: confirmed
---

# The Inbox stayed on a nearly spent account

## What was seen

On October 10 the Inbox router kept dispatching on a Claude account with almost no weekly allowance left while the other
account had refilled, heading toward a stop that the other account could have avoided.

## Cause

Ordinary turn dispatch (`bot/src/provider-account-choice.ts`, `provider-account-dispatch.ts`) preferred the account the
session last ran on while any room remained, and ranked by the tightest window; prior-session stickiness won over a much
larger weekly room elsewhere.

## Fix

c39ef67b ranks eligible ordinary turns by primary weekly room, using the prior account only for ties; a newly selected
account still wins its next turn and saved work stays bound to its account. 62c9f739 aligns the dispatcher comments and
usage runbook with that rule.

## Acceptance scenario

- **Seed:** Two Claude accounts: A (session's last account) at 97% weekly, 10% five-hour; B at 20% weekly, 60% five-hour.
- **Action:** Dispatch the Inbox session's next ordinary turn.
- **Expected:** The turn runs on B; with equal weekly room it stays on A.
- **Replayable offline:** yes (synthetic readings, pure chooser)
