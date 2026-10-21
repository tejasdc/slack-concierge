---
failure: After the ledger moved to its own disk, the background sync thread could not find the database log, so Concierge went back to waiting on the disk for every saved change.
date: 2026-10-10
fix_commits: [54c4d467]
cause_status: confirmed
---

# The ledger sync thread looked for the log in the old place

## What was seen

After the October 10 move of `state.db` onto its dedicated filesystem, the ledger sync thread failed with ENOENT,
durability fell back to synchronous commits, and the owner fsynced the WAL on its event loop again: the freeze the
durability threads existed to remove.

## Cause

`bot/src/ledger-durability.ts` opened `state.db-wal` next to the path in the state directory. That path is now a symlink;
SQLite keeps the WAL beside the real file on the ledger filesystem, so the expected WAL path did not exist.

## Fix

54c4d467 resolves the ledger's real path before deriving the WAL path, and documents it in
`docs/architecture/LEDGER-DURABILITY.md`.

## Acceptance scenario

- **Seed:** A scratch state directory whose `state.db` is a symlink to a file on another directory (or mount).
- **Action:** Start the owner and commit one change.
- **Expected:** The sync thread opens the WAL beside the real file and confirms the sync; durability stays asynchronous;
  no ENOENT.
- **Replayable offline:** yes (symlink in a scratch directory)
