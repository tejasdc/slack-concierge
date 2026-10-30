---
failure: Every communication wake re-read the whole events table about twenty times a second and walked most retained inputs twice, so the owner read hundreds of megabytes a second from its ledger and its service unit's accounted memory crossed the monitor's 8 GiB line.
date: 2026-10-30
fix_commits: []
cause_status: confirmed
---

# Concierge's own unit was reported at 8.4 GB while the owner itself held 0.5 GB

## What was seen

The work-flow supervisor opened incident `90834832-9f89-4f37-9607-2a39b5a5fbe9` at 17:05 UTC on
2026-10-30 with the one reason `owner_unit_memory_high`: the owner process held 509 MB resident
and 0 MB swapped, while `concierge-bot.service` accounted for 8,449 MB. The same reason had fired
at 03:37 UTC on the previous service incarnation at 10,907 MB. Requests were fast, the
presentation worker was caught up and host pressure was absent.

The unit's `memory.stat` split the 8.4 GB into 2.3 GB anonymous memory across the owner, its
workers and the meaning engine, and 6.0 GB of file cache, 5.4 GB of it inactive. Page-cache
residency showed the ledger file (5.8 GB) 66% resident and its WAL fully resident. The owner's
main thread had issued 5.8 TB of read calls in 8.5 hours against 3.7 GB actually read from disk,
and was reading 300 to 1,500 MB/s in bursts while idle between requests. A six-second trace of
`pread64` attributed 2.66 GB in 651,000 four-kilobyte reads to the primary ledger connection.
Mapping five seconds of exact page numbers through `dbstat` gave:

| Table (leaf pages)             | reads   | distinct pages | share |
| ------------------------------ | ------- | -------------- | ----- |
| session_communication_events   | 76,501  | 3,396          | 44.5% |
| session_inputs                 | 40,174  | 19,039         | 23.4% |
| turns                          | 9,505   | 4,751          | 5.5%  |
| session_communication_requests | 7,218   | 3,507          | 4.2%  |

That is about 22 full scans of the events table and two full walks of the inputs table in five
seconds, in the reconciliation pass that every execution change wakes (25 open requests dispatched
and 13 undelivered events delivered per pass).

## Cause

Two confirmed query faults in the communication reconciliation pass:

1. `session_communication_events` had no index on `request_id`. Every read of a request's events
   (`WHERE request_id=?` in dispatch, delivery, the overdue sibling probe, the liveness join, the
   latest-progress read and the request view) was a full scan of the 30 MB table. The peer table
   `session_peer_events` had this index since it was created; the local table never did.
2. The two recovery scans over `session_inputs` relied on the planner choosing the partial
   recovery indexes added on 2026-10-27. Bun's bundled SQLite 3.53 chooses the plain
   `session_inputs_turn` index for `turn_id IS NULL` instead and walks every input without a turn
   (37,492 of 54,476 rows). The system `sqlite3` used to confirm those plans chooses the partial
   index, which is why the 2026-10-27 check passed.

The monitor's unit-memory reason counts the cgroup's file cache by design; the cache that crossed
its line was the ledger being re-read.

## Fix

Index `session_communication_events(request_id)` and name the partial recovery indexes with
`INDEXED BY` in both recovery scans. On a private copy of the ledger under Bun's SQLite, 200
by-request lookups fell from 324 ms to 1.8 ms and each recovery walk from about 19 ms to 0.2 ms;
the undelivered-return audit and the liveness join kept or improved their plans.

## Acceptance scenario

- **Seed:** A ledger with thousands of retained requests and events (several events per request),
  tens of thousands of inputs most of which have no turn, a few dozen open requests and a dozen
  undelivered events.
- **Action:** Wake the communication reconciliation repeatedly, as execution changes do, under Bun's
  bundled SQLite.
- **Expected:** `EXPLAIN QUERY PLAN` for the by-request event reads seeks
  `session_communication_events_request`, and both recovery scans seek their partial indexes;
  one pass reads kilobytes from the events and inputs tables, not hundreds of megabytes. Live: the
  owner's ledger read rate between requests drops from hundreds of MB/s to near zero.
- **Replayable offline:** yes (query plans and read counts on an isolated database; the live read
  rate needs the installed owner).
