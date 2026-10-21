---
failure: Repeating scheduled checks, such as the Adidas drop watch, ran once and never again.
date: 2026-10-07
fix_commits: [3b82438b, 1741c864]
cause_status: confirmed
---

# Repeating schedules stopped after their first firing

## What was seen

On 2026-10-07 both repeating schedules on the server (including the Adidas drop watch set up for Gerald) fired once
and placed no next firing. The first fix shipped at 12:06 EDT and the schedules still did not repeat on the live
server until the second at 13:24.

## Cause

Confirmed from the two commits:

- `advanceRepeatingSchedules` (`bot/src/saved-work.ts`) placed the next firing only when it saw a queued firing that
  was already due. If the claim took the firing first (likeliest: the queue timer waking a hair before the due
  instant), nothing placed a successor, and the claim cleared the firing's dispatch time.
- The real cause on the server: the live service ran the Slack-enabled composition (`startSessionTurnQueue` in
  `bot/src/index.ts`), whose queue called `claimNextQueuedTurn` directly and never ran `advanceRepeatingSchedules` or
  `settleMissedScheduledWork` at all; only the native composition (`session-runtime.ts`) ran them.

## Fix

- 3b82438b: each firing records its own instant (`saved_fire_at_ms`); the latest firing of a schedule places the next
  once it is due or has left the queue by any path; drop, archive or suspend ends the schedule; one broken schedule is
  logged (`saved_repeat_advance_failed`) instead of failing every claim; both steps read one clock.
- 1741c864: both compositions claim through one function, `claimQueuedTurnWithSavedWork`, which runs the saved-work
  clock steps before `claimNextQueuedTurn`, so no composition can skip them.

## Acceptance scenario

- **Seed:** a session with a repeating schedule every 2 minutes, run under the composition the server uses.
- **Action:** let the first firing be claimed exactly at (or a moment after) its due time; let it finish; wait two intervals.
- **Expected:** a second and third firing are queued and run at their instants with increasing `saved_sequence`;
  dropping the schedule stops further firings.
- **Replayable offline:** yes (scratch ledger, fake provider, controllable clock)
