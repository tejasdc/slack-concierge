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

The page contains up to ten queued saved turns. Its response expanded a full session view for each turn. Each view reread execution, handoff and activity history even though the saved-work list only needs a session identity and title. At a full page, those lookups reached the registered 128-call ceiling. The ceiling correctly refused the read; the oversized projection caused this incident. The read completion log recorded the status and counts but omitted the refusal reason.

## Fix

The first release batched session fetches and reused each already-read saved turn. Its installed full page still returned 503 at 128 calls, confirming the full session view was the remaining problem. The final repair returns a compact session identity, address, provider, title and project for each saved turn, and leaves full views to the exact session read. The page's growth fixture now covers this entire response projection. Keep the existing read budget. Record a budget refusal's route, admission identity and limit reason in the bounded log sink.

## Acceptance scenario

- **Seed:** A private Concierge state with at least ten queued saved turns belonging to distinct sessions, with session titles and one older page.
- **Action:** Read the first saved-work page through the native read worker, then follow its cursor.
- **Expected:** HTTP 200 for both pages, ten distinct saved turns on the first page with their correct session titles and saved times, no repeated turn IDs, and fewer than 128 database calls for each page. An artificially lowered call budget still returns 503 and records `calls` as the refusal reason.
- **Replayable offline:** yes (the release growth fixture exercises the full response projection with scratch state; the installed read checks the HTTP result).
