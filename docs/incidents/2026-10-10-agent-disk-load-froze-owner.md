---
failure: Heavy disk work by agents froze Concierge for seconds to minutes (145 s on October 9), because every ledger commit waited on the same busy disk.
date: 2026-10-10
fix_commits: [02573596, 0f3d8d16, 56f863e6, 2d59b926, 479b1e68, 78b9de75, 35bf1816, 8c851bc9, a3e4e1a5, 0b2f0beb, 94d5d416, 200d238f]
cause_status: confirmed
---

# Agents' disk work froze the owner's event loop

## What was seen

On October 9 an agent's `sqlite3 .backup` of a live database saturated the md2 array and froze the owner for 145 s.
On October 10, 63 of 85 live stack samples showed the owner's commit waiting on the ext4 journal, for up to 100 s, while
agents wrote heavily; a three-minute sample showed the owner blocked 27% of the time. Pages and messages stalled.
Related but separate records: the [October 9 CPU saturation episode](2026-10-09-agent-workloads-saturate-the-host.md)
(fixed by CPU weighting) and the [52 GB orphaned diagnostic copy](2026-10-10-page-load-diagnostic-copy.md).

## Cause

Execution hosts and the Codex App Server ran unthrottled beside the owner. SQLite's default `synchronous=FULL` commit
fsynced the WAL on the owner's own event loop, and the ledger file lived on the root filesystem whose journal every
agent write also used. Smaller avoidable waits added to it: SQLite scratch files in `/var/tmp` created about three times a
second, and account reads rescanning every kept login and `~/.claude` 188 times in 15 s.

## Fix

- 02573596 launches execution hosts in `agents.slice` and moves the Codex App Server's scope there
  (`bot/src/agent-work-slice.ts`); remote-box caps the slice at 30 MB/s of writes.
- 0f3d8d16 commits with `synchronous=NORMAL` and hands fsync and checkpoint to worker threads
  (`bot/src/ledger-durability*.ts`); answers, provider input and peer requests await `ledgerDurable()`. 56f863e6,
  2d59b926 and 479b1e68 are review fixes of the same change (fail closed, restart on a lost sync thread, no stop-time sync
  on the loop).
- 78b9de75 keeps `temp_store` in memory with `SQLITE_TMPDIR=/dev/shm` and memoizes account-home reads for two seconds;
  35bf1816 serves profile listings from that memo.
- 8c851bc9 moves `state.db` and `meaning-index.db` onto a dedicated loop-mounted ext4 filesystem during the stopped update
  window (trial: writer blocked 35–53% on root vs 0.4–2% on the loop mount); a3e4e1a5, 0b2f0beb, 94d5d416 and 200d238f
  fence that move with SQLite's writer lock and refuse a link with no file.

## Acceptance scenario

- **Seed:** Owner running on a scratch ledger on its own filesystem; an execution host in `agents.slice` writing 2 GB as
  fast as it can on the root disk.
- **Action:** Drive steady owner commits (session events, a capture admission) during the write.
- **Expected:** Owner loop lag stays near idle levels (no tick over 1 s); every command answer is returned only after its
  rows are synced.
- **Replayable offline:** no (needs the real host's cgroup slice, disks and mount; a scratch copy can measure the commit
  path alone)
