---
failure: Every update left a 1.4 GB database copy behind forever, until the server disk filled and Concierge and phone captures stopped.
date: 2026-10-07
fix_commits: [b6a21f55]
cause_status: confirmed
---

# The server disk filled with update copies and Concierge and captures stopped

## What was seen

At 21:10 EDT on 2026-10-07 the capture ingress could not grow its SQLite shared-memory file
(`SQLITE_IOERR_SHMSIZE`), Concierge's startup could not reach it, and both services stopped: no
replies and no captures from his phone. The disk was full. 248 old database copies were deleted by
hand to recover.

## Cause

Confirmed from the commit. Every deployment's migration step (`bot/scripts/migrate-deployment-repair.ts`)
wrote a full `VACUUM INTO` copy of the ledger (~1.4 GB) to
`$CONCIERGE_STATE_DIR/backups/state.pre-deployment-repair.<ms>.db`, and nothing ever removed one: 278
copies, 151 GB. About thirty deployments on 2026-10-07 (the execution-host and fix series) used the last
free space.

## Fix

b6a21f55: after a migration that succeeds, `pruneAutomaticCopies()` keeps the newest 20 automatic copies
(and their `-wal`/`-shm` files) and reports how many it pruned. Only names matching the automatic pattern
are touched; hand-made backups and an explicit `CONCIERGE_DEPLOYMENT_MIGRATION_BACKUP` path are left alone.

Later records show the bound was still too loose or incomplete: on 2026-10-09 twenty 1.9 GB copies left
17 GB free and a Thinkering backup filled the disk (f9952bc9 lowered it to eight), and on 2026-10-10 copies
from failed updates escaped pruning ([updates copied the full ledger](2026-10-10-updates-copied-full-ledger-filled-disk.md)).

## Acceptance scenario

- **Seed:** a scratch state directory with a small ledger and 30 files named
  `state.pre-deployment-repair.<ms>.db` (some with `-wal`/`-shm`), plus a hand-named backup in the same folder.
- **Action:** run the deployment migration step successfully several times.
- **Expected:** after each run at most the bounded number of automatic copies remain (newest kept, with their
  sidecar files removed for pruned ones), the hand-named backup is untouched, and total backup bytes stop
  growing with the number of deployments.
- **Replayable offline:** yes (scratch state directory; no service or real disk pressure needed)
