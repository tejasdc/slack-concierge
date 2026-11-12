---
failure: After the owner crashed, Concierge's next three starts failed with "database is locked" before the fourth worked, each one sending a crash notice.
date: 2026-11-11
fix_commits: []
cause_status: confirmed
---

# Three failed restarts after a crash

## What was seen

At 05:33:45 UTC the owner's main process exited with status 1. systemd sent SIGKILL to the two
helpers still in the unit (the local speech model server and the presentation worker), reported
"Failed to kill control group ... Invalid argument" and "remains running after unit stopped" for
both, and restarted the service. The pre-start recovery (`control recover`) failed at 05:33:50
and 05:33:55 with `SQLiteError: database is locked` (SQLITE_BUSY), each failure firing the
service-failure notice. The start at 05:34:00 succeeded.

## Cause

The stack trace points at the ledger opener's first statement: `ledgerWriteResults` ran
`PRAGMA wal_autocheckpoint = 0` and prepared `SELECT changes()` before the caller set
`PRAGMA busy_timeout`. With SQLite's default wait of zero, any lock held at that instant failed
the start immediately. The Oct 7 fix ("Set the wait before journal_mode") had put the wait first;
the Oct 13 commit 54bad955 added those statements inside the opener, ahead of it, undoing that
for every opener.

Which process held the lock is not proven: the logs show the lock was held at 05:33:50.45 and
05:33:55.70 and gone by 05:34:00.8. The best explanation is the killed presentation worker that
systemd reported still present (a process blocked in a disk wait does not die until the wait
returns); nothing else in the journal touched the ledger in that window. Either way the start
should have waited rather than failed.

## Fix

The opener sets the lock wait before any statement. Ordinary connections wait five seconds, as
before; the service's pre-start recovery waits thirty, because nothing is serving while it runs
and the observed hold exceeded five seconds.

## Acceptance scenario

- **Seed:** a ledger file; another process holds `BEGIN EXCLUSIVE` on it and releases after 0.8 s.
- **Action:** open it through `ledgerWriteResults(new Database(path))` and run a query.
- **Expected:** the query succeeds after the holder releases; before the fix it threw
  `database is locked` at once.
- **Replayable offline:** yes
