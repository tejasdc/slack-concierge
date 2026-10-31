---
failure: Saved work stopped loading in thnkr.ing when a full page exceeded Concierge's read-call budget.
date: 2026-10-31
fix_commits: []
cause_status: confirmed
---

# Saved work stopped loading

## What was seen

From about 08:10 UTC on October 31, Concierge's saved-work read returned 503. A direct read of the installed read socket returned `READ_BUDGET_EXCEEDED` with reason `calls`. Its completion record showed exactly 128 database calls, 91 rows, zero database errors and a response in roughly 8–13 ms. thnkr.ing passed the refusal through, so saved work and agent schedules could not load.

## Cause

The page contains up to ten queued saved turns. Its response expanded a full session view for each turn, fetching each session separately and reading the same saved turn again inside that view. At a full page, these repeated lookups reached the registered 128-call ceiling. The ceiling correctly refused the read; the unnecessary lookups caused this incident. The read completion log recorded the status and counts but omitted the refusal reason.

## Fix

Fetch the page's sessions in one bounded query, and give each session view its already-read saved turn. Preserve the existing response and read budget. Record a budget refusal's route, admission identity and limit reason in the bounded log sink.

## Acceptance scenario

- **Seed:** A private Concierge state with at least ten queued saved turns belonging to distinct sessions, with the ordinary session metadata needed for their views.
- **Action:** Read the first saved-work page through the native read worker.
- **Expected:** HTTP 200, ten distinct saved turns with their correct session titles and saved times, a continuation cursor when more turns remain, and fewer than 128 database calls. An artificially lowered call budget still returns 503 and records `calls` as the refusal reason.
- **Replayable offline:** yes (private scratch state and the native read worker).
