---
failure: The owner stalled for up to 1.3 seconds at a time while searching historical routing evidence and while warming the Inbox thread index after a restart.
date: 2026-10-12
fix_commits: [2ece67b7]
cause_status: confirmed
---

# Historical search and index warm-up held the owner loop

## What was seen

On October 12, historical routing search held the accepting owner in synchronous SQLite transactions for 0.6–1.3 s per
call. The background warm-up of the Inbox thread index (added that morning by 0ec41a8b to move the build out of his first
tap, see [that record](2026-10-12-thread-index-rebuilt-in-his-first-tap.md)) took about 1.2 s per 250-row step under load.

## Cause

Historical routing search ran on the owner's own loop and connection (`bot/src/session-topics.ts`, `session-owner.ts`)
rather than in the read-only search process. `warmEntryIndex` bounded its steps only by row count, so a step's time grew
with disk contention.

## Fix

2ece67b7 runs the historical routing read in the sealed read-only search process (`presentation-search-read.ts`,
`presentation-search-client.ts`), keeping result attribution and incomplete-coverage reporting, and caps each warm-up step
by both rows and elapsed time, yielding between steps.

## Acceptance scenario

- **Seed:** A ledger with large historical routing evidence and 2,500+ Inbox roots; disk under write load.
- **Action:** Restart the owner and issue a session search with historical evidence.
- **Expected:** Search results carry the same attribution and coverage; no owner loop tick from search or warm-up exceeds
  the step time cap.
- **Replayable offline:** yes (scratch ledger; contention optional)
