---
failure: An update's new Concierge failed its first start because the retiring one still held the database lock for a moment.
date: 2026-10-07
fix_commits: [4c636849]
cause_status: confirmed
---

# A restart's recovery preflight failed on a briefly held database lock

## What was seen

In incident 62bd0860 on 2026-10-07, the first start of a new release failed at `PRAGMA journal_mode = WAL` with
`SQLITE_BUSY`. The automatic start one second later succeeded, but the update recorded a failed start.

## Cause

Confirmed from the commit and its documentation in `docs/architecture/DEPLOYMENT-REPAIR.md`. `bot/src/state-database.ts`
set `PRAGMA busy_timeout = 5000` after `PRAGMA journal_mode = WAL`. Selecting WAL mode needs SQLite's writer
lock, and at the restart boundary the retiring coordinator could still hold a short writer transaction. With no
busy timeout yet configured, the pragma failed immediately instead of waiting.

## Fix

4c636849: the busy timeout is set first, before any pragma that can take the writer lock, so recovery waits up
to five seconds for the previous owner instead of failing.

## Acceptance scenario

- **Seed:** a scratch ledger in WAL mode; a second process holding a `BEGIN IMMEDIATE` writer transaction for ~1 s.
- **Action:** open the ledger through `state-database.ts` while the lock is held.
- **Expected:** the open waits and succeeds after the lock is released; no `SQLITE_BUSY` at `journal_mode`.
- **Replayable offline:** yes (two local processes against a scratch database)
