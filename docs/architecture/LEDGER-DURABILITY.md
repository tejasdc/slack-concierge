# Ledger durability off the owner's loop

## Problem

SQLite's default commit (`synchronous=FULL`) syncs the write-ahead log on the calling thread, and
its automatic checkpoint syncs the log and the database file there too. The accepting owner commits
on its event loop, so every ledger write could wait on the disk. Under agent disk load that wait
went through the ext4 journal: a live sample on 2026-10-10 caught the owner in
`fsync → ext4_sync_file → jbd2_log_wait_commit` in 63 of 85 samples, and the owner froze for
15–100 seconds at a time; at 02:43 ET the supervisor killed it while it sat in that wait.

## Boundary

`bot/src/ledger-durability.ts` (started by `startRoutedRequestApi` in both runtime compositions,
Linux only) changes where the disk is waited for, not what is written or when it commits:

- The owner's connection commits with `synchronous=NORMAL` and `wal_autocheckpoint=0`. A commit
  appends to the log in the page cache and returns. SQLite documents NORMAL in WAL mode as safe
  from corruption; a power loss or kernel crash may lose the most recent commits. A process crash
  or kill loses nothing, because the kernel still holds the written pages.
- A **sync thread** (`ledger-durability-worker.ts`, role `sync`) runs `fdatasync` on the log on
  request and once a second while rows are unsynced. Requests coalesce (group commit).
- `ledgerDurable()` (`ledger-durability-barrier.ts`) resolves once every commit made before the
  call is synced. Waiters resolve in call order. It samples the connection's `total_changes()` in a
  microtask, after any enclosing synchronous transaction has committed.
- **Nothing leaves the process before the rows it rests on are durable.** The barrier sits on the
  owner socket's non-GET answers (command receipts, for the gateway, Thinkering and router
  commands alike), on a provider run's start (Claude, Codex, ChatGPT), on every command to a Claude
  execution host and every host launch, on every Codex app-server request (before its answer timer
  starts, so a slow disk is never read as an ambiguous send), and on peer POSTs. GET reads and the
  supervisor's liveness ping answer at once. Not covered: Thinkering notifications and pushes,
  project files and attachment files written by the owner; after a power loss those can describe a
  row that was lost, which repeats or orphans a notice but never replays provider work.
- A **checkpoint thread** (role `checkpoint`, its own `synchronous=FULL` connection) runs
  `PRAGMA wal_checkpoint(PASSIVE)`, which never takes the writer lock. It reads how much log is
  uncopied from the documented wal-index header in `state.db-shm` (frames written minus frames
  copied), and copies once 64 MB is waiting while `/proc/pressure/io` "some avg10" is at most 10%,
  or at 1 GB regardless. It never copies a small log.

## What still waits on the loop

After a complete checkpoint the owner's next commit rewinds the log, and SQLite syncs the log
header on that thread (NORMAL keeps this sync; it is what prevents stale frames being replayed
after a power loss, so it is not removed). The checkpoint policy makes it rare (once per 64 MB of
ledger writes, roughly every few minutes at today's rate) and places it after quiet-disk
checkpoints. Ordinary `write()` and `read()` calls on the ledger can still wait briefly on the
journal for timestamp updates (6 of the 85 samples) and on page-cache misses. A complete removal
of ledger I/O from the loop is the serialized database executor in the 2026-10-10 boundary review;
it was not built because it converts ~90 files of synchronous ledger code to asynchronous
operations, and this change removes the measured wait without changing any transaction.

## Failure handling

If either thread errors or exits, or a sync fails, the owner returns to `synchronous=FULL` with
automatic checkpoints, syncs the log once on its own thread before releasing any waiter, and logs
`ledger_durability_fallback` at error level. Stopping the request API does the same quietly; when
nothing is waiting, that one sync is left to the next caller of the barrier, so a shutdown under
disk load does not hold the loop.
`meaning-index.db` (a derived, rebuildable index) commits with `synchronous=OFF` and is rebuilt
from the ledger if it cannot be opened after a crash.

## Signals

- `GET /supervisor/ping` → `ledgerDurability`: mode, sync count, slow syncs, slowest and last sync
  time, waiters, age of the sync in flight, unsynced changes, checkpoint counts. This is database
  completion latency, kept apart from the owner's loop lag (`owner_event_loop_lag`).
- `ledger_durability_slow_sync` (warn, sync ≥ 1 s), `ledger_checkpoint` (each checkpoint, with
  bytes, pressure and SQLite's result), `ledger_durability_started`, `ledger_durability_fallback`.
