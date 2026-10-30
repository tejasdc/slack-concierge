---
failure: Concierge crashed and restarted because a locked database made the five-second pause check throw where nothing caught it.
date: 2026-10-30
fix_commits: []
cause_status: confirmed
---

# Concierge crashed at 3:59 AM and interrupted running work

## What was seen

On 2026-10-30 at 03:59 ET concierge-bot.service exited with status 1 and restarted. The journal shows
`SQLiteError: database is locked` (SQLITE_BUSY) thrown from `syncGlobalPausePeers`, which ran in the
background, alongside a 16 s ledger durability sync. A Thinkering agent was unpacking a full backup
into /var/tmp at about 89 MB/s, and disk pressure was about 80%.

## Cause

`syncGlobalPausePeers` runs from `setInterval(() => void …, 5_000)` and from other `void` calls. Its
peer-state write failed on the locked ledger. The write in its `catch`, which records the error,
failed for the same reason, and that rejection had no handler, so Bun ended the process. The
synchronous writes at the start of the method and the Mac path's fail-closed write could escape the
same way.

## Fix

The public method is now a wrapper that never throws or rejects. Any failure in a pass is logged as
`global_pause_peer_sync_failed`, and the next five-second pass retries. Disk pressure was the
trigger; a background reconciliation must not be able to end the owner whatever the ledger does.

## Acceptance scenario

- **Seed:** a cloud owner with one peer and a ledger whose writer lock is held by another
  connection beyond the busy timeout.
- **Action:** the five-second pause reconciliation runs.
- **Expected:** a `global_pause_peer_sync_failed` warning is logged, the process keeps running, and
  a later pass after the lock is released records the peer state.
- **Replayable offline:** yes
