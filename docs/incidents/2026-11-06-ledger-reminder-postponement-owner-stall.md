---
failure: Postponing an optional reminder for healthy work blocked Concierge's live request handling for 20 seconds.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# A healthy-work reminder held live requests behind a ledger read

## What was seen

At 12:57:59 UTC the Concierge owner loop lagged 20.489 seconds. Its synchronous ledger
occupancy was 20.689 seconds, including one 20.145-second statement during request
reconciliation. The installed statement fingerprint identifies the update that moves a
healthy request's next reminder deadline. Kernel samples show SQLite waiting on page
reads while executing that update. A separate WAL durability sync took 22.170 seconds
at the same time; its queue and callback delivery were 0 and 2 ms respectively. The
two waits are measured separately and neither proves the other's cause.

## Cause

The owner wrote a new deadline to SQLite each time it found an already accepted
request still running, held by an update, or waiting on a dependency. That deadline
is an optional next inspection, while durable acceptance, overdue events, and final
answers are separate records. The synchronous update ran on the same event loop that
must deliver completed durability barriers and accept live requests. A cold page read
inside that update therefore held unrelated work.

## Fix

Keep this optional next inspection in the coordinator's memory for fifteen minutes.
The accepted request and any actual overdue event remain in the ledger. The request
receipt reports the effective next inspection. A restart rechecks the still-due
request against its current health; it does not replay a reminder or an accepted
request. The timer also considers other stored deadlines, so one healthy request
cannot hide another request that becomes due sooner. This change removes only the
optional postponement write; it does not shorten a WAL sync or another ledger read.

## Acceptance scenario

- **Seed:** An accepted request is due for inspection while its recipient is still
  running under a live owner. A second request has a later stored deadline.
- **Action:** Reconcile the due request, wake reconciliation again, then restart the
  coordinator before the next fifteen-minute inspection.
- **Expected:** The healthy request emits no overdue event and its stored deadline
  is not rewritten; its receipt shows a future effective inspection. The second
  request remains eligible at its own deadline. After restart the first request is
  re-inspected, without a duplicate reminder or replayed work.
- **Replayable offline:** yes (native request coordinator with a retained ledger).
