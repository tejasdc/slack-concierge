---
failure: A routine file-watch observation write held Concierge's interactive owner loop for nearly two seconds.
date: 2026-10-31
fix_commits: []
cause_status: confirmed
---

# Routine watch bookkeeping stalled the interactive owner

## What was seen

At 08:16:55 UTC on 2026-10-31, Concierge logged 1,966 ms of owner event-loop lag. Its
slow-statement record measured 1,975 ms in the one-row watch observation update, while
the process used only 143 ms of CPU over the lag interval. The same call occupied the
loop for 1,041 ms at 08:22 and 1,144 ms at 08:24. Two independent history reads ended
at 08:16:55.845, 118 ms after the first stall. Their separately measured read-worker
SQLite calls were under 0.1 ms; those durations exclude the history worker's own ledger
reads. Two slow actions at 08:20 settled promptly in Concierge without owner-loop lag.

## Cause

Every unchanged file-watch poll synchronously updated its durable last-observed cursor
on the accepting owner's JavaScript thread. That cursor exists so a restart or sleep
cannot claim continuous observation without evidence. The call blocked the loop during
the measured SQLite statement. The logs do not identify the statement's wait site, a
SQLite writer-lock holder, or a disk operation. A writer lock alone does not explain the
simultaneous history reads in SQLite WAL mode. Shared storage, checkpoint work, history
worker handoff and scheduler pressure remain possible contributors to the broader delay;
see [ledger durability](../architecture/LEDGER-DURABILITY.md). This record attributes
the owner-loop stall to the synchronous watch call, not the overall thread-read p95 to
that call or the one-row update itself as the root storage cause. The 08:24:47 stall
ended four milliseconds before a 2,608 ms checkpoint ended; this supports shared
storage pressure for that event but still does not reveal the statement's wait site.

## Fix

Unchanged-poll cursors now write on a sealed thread to a separate SQLite store. The
interactive owner awaits the result asynchronously, so a slow cursor statement cannot
occupy its JavaScript loop or hold the main ledger's writer lock. At startup the owner
loads confirmed cursor evidence once; while serving it uses in-memory confirmed values.
The cursor thread refuses lock contention in its own store immediately in production.
A failed observation leaves the prior cursor unchanged and the next successful poll
records the interval as a possible gap. Registration, terminal settlement, renewal and
delivery keep their existing durable owner path; terminal settlement copies the cursor
and gaps into that transaction. Shared disk pressure can still affect other ledger
operations, so this fix does not claim to cure all storage stalls or history latency.

## Acceptance scenario

- **Seed:** a scratch main ledger and a valid but table-less watch cursor store, as an
  interrupted first creation might leave; after initialization a connection holds an
  immediate writer transaction on the cursor store. First present a damaged cursor file
  and verify the owner-side load returns before replacing it with the table-less store.
- **Action:** ask the actual watch observation thread to record an unchanged poll under
  a test-only 2.5-second SQLite busy timeout, count main-loop timer ticks, release the
  lock, then record the next observation at 20 seconds.
- **Expected:** a damaged cursor file logs a failure without stopping owner startup;
  startup initializes the table-less store; the first call waits about
  2.5 seconds and fails while the main loop
  continues to tick and an independent main-ledger write succeeds; the next call
  succeeds and the watch records a possible gap from zero to 20 seconds.
- **Replayable offline:** yes (`bot/scripts/watch-observation-acceptance.ts`, using only
  scratch state under `/tmp`).
