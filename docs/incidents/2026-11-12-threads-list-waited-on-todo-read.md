---
failure: Each Threads list page took a constant three seconds while thnkr.ing's to-do list read was timing out.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Threads list pages waited on the to-do read's timeout

## What was seen

On Nov 12, 20:18:59–20:19:14 UTC (15:18 ET), the loading-signs agent measured four
consecutive Threads list reads at 3,029, 3,022, 3,027 and about 1,000 ms; response headers
arrived at about 3.02 s. A reload took 14.3 s to fill four pages. The owner's own lines for
those reads show `duration_ms` 3,016–3,022 with 10 ms of database work and `awaited_ms` 0.

## Cause

Before answering `GET /presentation/topics` and `/presentation/questions` (and session
windows, session views and Inbox attention pages), the owner awaited
`closeQuestionsAnsweredByTodos`, which reads every one of his to-dos from thnkr.ing's capability
socket with a three-second timeout. Each slow read ended 2–3 ms after a
`question_todo_check_unavailable … reason: timeout` line (three of three at 20:19:03, :06 and
:09). That timeout fired 11 times between 07:00 and 20:30 UTC. Because the wait was not wrapped
as outside time, the read logs showed it as unexplained owner time rather than awaited time.

## Fix

The views start the same check in the background, at most one at a time per scope, and answer
at once from stored state. A question it settles leaves through the ordinary question change,
whose live event refreshes the screen. The to-do read is now recorded as outside time. The
three-minute reading cadence still runs the same check.

## Acceptance scenario

- **Seed:** an open decision question linked to a to-do; thnkr.ing's to-do read stalls.
- **Action:** read the Threads list.
- **Expected:** the list answers without waiting for the to-do read; when the to-do read later
  returns Done, the question settles and a change event is published.
- **Replayable offline:** no automated fixture; installed check by Threads read durations while
  `question_todo_check_unavailable` lines occur.
