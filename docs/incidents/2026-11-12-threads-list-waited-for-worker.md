---
failure: His Threads list and widget took about four seconds to load, and the owner froze for 5 to 26 seconds after each restart.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Threads list waited for the presentation worker; restarts froze the owner

## What was seen

The Nov 12 nightly review measured the Threads list read (`/presentation/topics`) at
p95 4,033 ms over 24 hours (max 8,146 ms), against p95 19 ms the night before; the Inbox
topics read and the widget board matched it. The owner logged 177 event-loop stalls, 18
over three seconds, the worst 26,191 ms.

## Cause

Two independent causes, both read from recorded evidence.

1. **The list read waited.** Commit e45c6d74 (installed Nov 11) made the first page wait up
   to four seconds for the presentation worker to reach the ledger head seen at admission.
   The head moves with every agent's activity, and worker batches take 0.2 to 1.5 seconds
   (minutes during whole-list recomputes after releases), so almost every read waited. The
   owner's `native_read_request_completed` lines show 2 to 4 s per read with about 10 ms of
   database work and the rest `awaited_ms`, each ending just after a `presentation_worker_batch`.
2. **Restarts froze the owner.** After a restart, the Inbox entry index (about 20,000 rows)
   is filled in yielding steps that take 45 to 195 seconds. The unfiled-capture wake and the
   router's "unfiled from earlier routers" prompt context read the index on a timer or peer
   request 25 to 60 seconds after start and finished the remaining rows in one synchronous
   read. Every stall over 2.5 s traced to statement `c3f639c97722e2c7` under
   `extendEntryIndex ← entryIndex ← unfiledInboxRoots`, and each began 25 to 60 s after a
   `startup_repairs_deferred` restart line (11 of 11 on Nov 11 to 12). Separately, a thread
   link or his split control discarded the whole index, so the next reader rebuilt it the
   same way.

The thread changes merged Nov 11 to 12 were not the cause.

## Fix

The device's list read answers at once from the prepared copy; when it is behind it answers
incomplete with a one-second retry hint, so the visible rows stay and refresh about a second
later. Agents' `sessions topics list` keeps the bounded wait. Background readers of the entry
index skip while the warm-up is running (the next upkeep pass covers them), and thread links
no longer discard the index: the root memo already follows `thread_link` events incrementally.

## Acceptance scenario

- **Seed:** A prepared list ready but one source change behind.
- **Action:** Read the first page over HTTP; advance the worker; read again; read a cursor page
  after a later unrelated write.
- **Expected:** Each answer arrives in well under 300 ms; the first is incomplete with
  `retryAfterMs: 1000`, the second complete, the cursor page complete.
- **Replayable offline:** yes, `bot/tests/prepared-topic-readiness.test.ts`.

Installed acceptance: `/presentation/topics` read durations from the owner journal after the
release, and no `extendEntryIndex` stall after the next restart.
