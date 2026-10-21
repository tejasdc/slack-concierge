---
failure: Concierge froze for up to a second at a time while an update was being built, because short-lived update commands did the database's checkpointing and searches reopened an index file on the busy disk.
date: 2026-10-12
fix_commits: [800a949d]
cause_status: confirmed
---

# Owner commits stalled behind update-runner checkpoints

## What was seen

Live sampling during deploy builds on October 12 showed the owner's commits busy-waiting while short-lived update
commands (`deploy-state`, `release-manager promote`) held the WAL writer lock in fsync of `state.db`; the WAL had grown to
285 MB. Searching old conversations held the owner up to 1.6 s under load.

## Cause

SQLite's default autocheckpoint ran inside those short-lived processes, because the owner's checkpoint thread rarely
passed its IO-pressure gate and the log kept growing; the first committer past the threshold paid for the checkpoint
while holding the writer. Separately, `bot/src/meaning-index.ts` opened Thinkering's archive search index per page and
per search, and each open chowned its WAL on the root filesystem.

## Fix

800a949d sets `wal_autocheckpoint=0` on every Linux ledger connection (`state-database.ts`), leaving the owner's
checkpoint thread as the only checkpointer, which now copies at 256 MB regardless of pressure
(`ledger-durability.ts`). The meaning index holds one read-only connection per archive index file and reopens it only when
the file is replaced.

## Acceptance scenario

- **Seed:** Owner on a scratch ledger with a WAL above the autocheckpoint size; a disk under write load.
- **Action:** Run a short-lived helper that commits one row, and issue ten archive searches.
- **Expected:** The helper's commit does not checkpoint (WAL unchanged by it); the owner's checkpoint thread copies at its
  threshold; the archive index file is opened once.
- **Replayable offline:** yes (scratch ledger; the latency effect needs a loaded disk)
