---
failure: Concierge's check for late saved work read every turn ever recorded on each usage reading, so a busy disk froze the whole service for seconds.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# Concierge stalled for 17 seconds in five minutes after a release restart

## What was seen

The supervisor opened a degradation incident at 19:41 UTC with `owner_loop_blocked`: 16.5 s of
main-loop blocking in five minutes, against its 15 s line. Concierge kept answering and no request
was slow. The stalls ran from 19:39:59 to 19:40:27 UTC, fourteen minutes after the 19:25:27 release
restart, and stopped on their own.

## Cause

Two things added up.

**Operational, the larger share (about 9.7 s).** In the minute ending 19:40:00 a command under the
shared Codex App Server's scope read 9.2 GB from the disk while Thinkering's restic backup and a
Thinkering ship were also reading. A 67 MB ledger checkpoint took 7.3 s in the same seconds. The
owner's loop sat in a page read for 7.4 s inside the undelivered-returns audit: its statement got
100 KB from the disk in 6.5 s, so the disk was the wait, not the query.

**Code, the share that crossed the line (about 4.2 s).** Saved-work inspection runs on the owner's
loop with every provider usage reading. Its single statement joined "still queued" and "missed its
expiry" with an OR, which neither partial index on saved work can serve, so SQLite scanned the whole
turns table: 32,779 rows, 301 MB on disk. The owner's own read accounting for the 19:40:26 stall
shows that one statement making 22,978 reads for 94 MB, 123 MB of it from the disk, in 2.9 s. It
needed 16 rows. Warm, the same scan cost 50 to 260 ms on every reading; cold, it held the loop for
seconds. Without it the five-minute sum was about 12.3 s and no incident would have opened.

## Fix

The inspection makes two indexed reads: queued saved work through the existing partial index, and
missed scheduled work that has not yet raised its one alert through a new partial index. The second
statement names its index, so it refuses to run as a scan. Already-alerted missed rows were fetched
and skipped before; they are no longer read.

Not changed: the disk load from other workloads, and the audit statement that waited on it.

## Acceptance scenario

- **Seed:** a turns table with thousands of finished turns, one queued scheduled turn past its time,
  one errored scheduled turn past its expiry with no alert, and one already alerted.
- **Action:** run saved-work inspection once.
- **Expected:** the first two each raise one alert, the third raises none, and the plan of every
  statement the inspection ran over turns names a saved-work partial index instead of scanning the table.
- **Replayable offline:** yes
