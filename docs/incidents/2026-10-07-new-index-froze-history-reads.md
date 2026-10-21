---
failure: A new database index made opening a conversation's history freeze Concierge for 6-24 seconds and slowed Inbox pages about thirtyfold.
date: 2026-10-07
fix_commits: [c826cc9b, 8505380e]
cause_status: confirmed
---

# A performance index made history reads freeze Concierge

## What was seen

From 07:26 UTC on 2026-10-07, after a9d232ba was installed, `owner_event_loop_lag` showed bursts of 6-24 s whenever
a conversation's history was read: every reply and page stalled meanwhile. Inbox page reads went from 2.4 ms to
76-80 ms and thread pages from 20 to 106 ms per 500-row step.

## Cause

Confirmed from the commits. a9d232ba added a general index `session_owner_events_kind_sequence (kind, sequence)`
for the thread-link watermark. The ledger has no planner statistics, so SQLite chose it for the two history
projections in `session-history-projection.ts` and `session-message-metadata.ts` because it satisfies
`ORDER BY sequence`, walking every message event in the ledger per page (3.3-3.7 s per query) instead of seeking
each requested message. It also turned every Inbox page read into a four-way index union over all Inbox events.

## Fix

- c826cc9b: both history joins drive from the requested list (`json_each(?) CROSS JOIN session_owner_events`) and
  seek `session_owner_events_message_lookup`: 0 ms on the same data.
- 8505380e (after a read-only review): drops the general index and creates the partial
  `session_owner_events_thread_link ON (sequence) WHERE kind='thread_link'`, which no other query can use; removes
  `INDEXED BY` so a later rename cannot break history reads. Measured on a ledger copy: Inbox page 6.5 ms, thread page
  20 ms, history projection 0.9 ms. The lesson is in AGENTS.md (731d5c7b): make new indexes partial or narrow and time
  hot reads on a copy.

## Acceptance scenario

- **Seed:** a copy of a production-sized ledger (or a generated one with ~1M owner events) after the full schema
  initialization.
- **Action:** read a 160-message history page, an Inbox page and a thread page; inspect `EXPLAIN QUERY PLAN`.
- **Expected:** history projection under a few ms using the message-lookup index; no plan uses an index on
  `(kind, sequence)`; Inbox and thread pages within their measured baselines.
- **Replayable offline:** yes (ledger copy or generated ledger; plan and timing checks only)
