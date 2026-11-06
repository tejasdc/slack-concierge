---
failure: A managed Concierge release left the request entrance unavailable for 37 seconds while the owner restarted.
date: 2026-11-06
fix_commits: []
cause_status: best-explanation
---

# Owner restart gap after the migration-lock repair

## What was seen

The managed release at 03:24 UTC on 2026-11-06 succeeded, but Concierge's request
entrance was absent from 03:24:04.830, when the old owner began draining, until
03:24:42.173, when the new owner finished opening it: 37.343 seconds. The
foreground gateway retained requests during the interval and logged delayed
delivery through 03:24:55. This is Concierge's owner restart, not a thnkr.ing
restart. The preceding migration-lock failure and its retry handoff have their
own repair records.

The old owner's session-communication stop took 1 ms. Its execution-host stop
took 8,096 ms. This release did not log which of the four concurrent stop
components consumed that time. The replacement's module load took 8,216 ms,
including 7,809 ms of ledger work. Its prior-turn recovery took 11,333 ms,
including 11,263 ms of ledger work. The slowest recovery statement took 8,757 ms
and was the query that looked for settled execution hosts. A read-only query plan
showed it scanning all 13,338 historical execution rows, with only 13 still live.
Adding the predicate of the existing partial index made SQLite scan that index.
The request entrance itself then took 2,112 ms to open.

The next managed release, at 03:49 UTC, installed the first repair. Its measured
gap was 31.159 seconds (03:49:10.867 to 03:49:42.026). Module load fell to
1.411 seconds, including 0.985 seconds of ledger work. The old execution-host
stop still took 7.567 seconds; this was the last start without per-component
stop timing. Prior-turn recovery took 8.541 seconds, including 8.482 seconds
of ledger work. Its slowest statement took 7.389 seconds and scanned settled
execution records for folders due for deletion; the live query returned no
eligible folders. The historical unreadable-reading sweep cost 2.722 seconds
and 40,712 ledger calls on this first start, then recorded its completion mark.

## Cause

Module-load's slowest ledger operation was an outer transaction, so its fingerprint
was null. Source inspection found a full foreign-key check inside the schema
initialization transaction on every start. A bounded read-only probe of that same
check did not finish within 15 seconds on the live ledger. This is strong evidence
for the module-load cost, but the exact fraction within that transaction was not
separately instrumented. The change keeps the full check when startup changes
the schema; ordinary writes retain SQLite foreign-key enforcement. The release
controller also verifies the migration backup before installation.

## Fix

Other repeated startup work included 1,752 ms and 39,766 ledger calls to
reinspect historical reading items. That repair now records a durable completion
event after its full pass. New reading items are refused at admission if they
have nothing to read. The execution-host shutdown now logs each component's
duration, and asks its read-only history worker to terminate without waiting
for the worker's synchronous read to return. The next managed release must be
measured to determine whether that worker accounted for the 8,096 ms stop.

The second release exposed another startup dependency: month-old execution
folder cleanup ran inside prior-turn custody recovery, even when no folder
was due. Custody recovery only needs active executions. The follow-up moves
historical folder cleanup after the request entrance opens and pages through
the execution ledger in small reads with pauses. It retains the one-month
retention rule and only marks an execution pruned after its folder or runner
payload cleanup succeeds. An interrupted pass revisits remaining rows on the
next start, after the request entrance opens.

The 04:11 UTC managed release installed that follow-up. The measured gap fell
to 14.358 seconds, from drain at 04:11:30.778 to request API completion at
04:11:45.136. The old owner's execution-host stop took 1 ms; all four logged
components took 0 ms at the available precision. Its request surfaces were
closed by 04:11:30.838, but full drain did not complete until 04:11:36.813.
The old owner exited at 04:11:37; the replacement started at 04:11:39.
Module load took 0.798 seconds, prior-turn recovery 0.945 seconds, and request
API opening 1.405 seconds. Active execution hosts were adopted after restart.
The remaining roughly six seconds after request-surface closure are not yet
attributed to a specific shutdown step. Logs show a 5.8-second event-loop stall
and a delayed durability-worker reply in that interval; the worker's own disk
sync took only 28 ms, so that delay cannot be assigned to disk sync alone.
The next release logs each remaining awaited drain step before changing its
custody or shutdown semantics.

The 07:57 UTC ordinary release exercised the owner with the early Codex observer
stop installed. Drain began at 07:57:03.783 and the request API opened at
07:57:13.096, a 9.313-second gap. Observer stop joined in 0 ms and no observer
lifecycle write started during drain. Capture stop took 4.869 seconds and
overlapped a 4.777-second unmarked event-loop pause with 1 ms of ledger wait.
The same overlap occurred at 07:10 and 07:24. The task that ended immediately
before each pause is not a proven cause. The capture worker now records the
synchronous cancellation time separately from its remaining stop wait, plus its
activity at stop, so the next release can distinguish cancellation from another
pause or an in-flight delivery without relaxing exact receipt custody.

## Acceptance scenario

Acceptance requires the next normal managed release's old-owner drain, new
module load, prior-turn recovery, request-API opening, functional health and
marked request entrance to be recorded separately. Keep surviving agent turns
under their exact execution and request identities. A successful release with
no pending peer read cannot prove the peer-read cancellation branch, and a
clean migration cannot prove the transient SQLite lock retry branch.

- **Seed:** A deployed Concierge owner with active, externally hosted agent turns and its historical ledger.
- **Action:** A normal managed release stops the old owner and starts the candidate.
- **Expected:** The old owner stops promptly; the request entrance opens with the candidate's exact release identity; the foreground gateway resumes delivery; active turns retain their exact custody; startup and stop logs identify the remaining measured gap.
- **Replayable offline:** no (the gap depends on the running owner, systemd stop, disk, and the real historical ledger).
