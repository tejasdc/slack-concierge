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
