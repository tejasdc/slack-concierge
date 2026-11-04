---
failure: Two investigations each copied the whole 8 GB Concierge ledger into /tmp through the approved snapshot script to run a few queries, taking the root disk under its 50 GB floor and firing the disk alert.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Approved ledger snapshots filled the root disk

## What was seen

At 10:43 ET and again at 12:26 ET on 2026-11-04 the same Codex session (concierge:8251, "Keep
every failed task owned until it is resolved", rollout `01a1a732-8ca6-72f1-9c44-ae80f5c7ff48`)
ran `python3 scripts/diagnostic-sqlite-snapshot.py /var/lib/concierge-ledger/state.db
/tmp/concierge-request-audit-20261104/state-snapshot.db --max-seconds 600`, then the same command
to `/tmp/dropped-task-ledger-20261104.db --max-seconds 450`. Each wrote 7.6–8 GB to the root disk
and took it under the 50 GiB floor; `AX41DiskFillingEarly` fired. The second copy was then read by
a reviewer subagent with a few dozen small read-only queries, each answering in milliseconds.
An agent filed the report at 18:04 UTC.

## Cause

The command guard refuses raw copies of a live store and, in its refusal, sends agents to the
bounded snapshot script, which it allows. That script bounded time, bytes and dirty data but never
asked whether the destination disk could afford the copy, and nothing named a way to query the
live ledger without copying it. So the approved path made a full copy the default for one-off
analysis. Both copies went through the guard exactly as designed.

## Fix

`scripts/ledger-read.py` is the sanctioned read: one read-only statement against the live
database where it is, bounded by a deadline and a row cap, costing no disk. The snapshot script
now refuses, before writing, a copy that would leave its destination filesystem under the host's
disk floor (read from remote-box's `AX41DiskFillingEarly` rule; a tenth of the filesystem where
that rule is absent), and its refusal and the guard's both name the read path first.

## Acceptance scenario

- **Seed:** A WAL SQLite database larger than the destination filesystem's free space minus the
  disk floor.
- **Action:** Run the snapshot script to a destination on that filesystem; then run
  `ledger-read.py` against the source with a query, a cross-join that outlasts `--max-seconds 1`,
  and a `DELETE`.
- **Expected:** The snapshot is refused with no file written and names the read path. The query
  prints JSON rows; the cross-join is interrupted with a narrowing hint; the `DELETE` fails as a
  read-only database.
- **Replayable offline:** yes (scratch databases; a tmpfs with a low free space reaches the
  floor branch)
