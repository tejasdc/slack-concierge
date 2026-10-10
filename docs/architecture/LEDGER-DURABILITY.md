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
  uncopied through `PRAGMA wal_checkpoint(NOOP)` (frames written minus frames copied) and
  `PRAGMA page_size`, and copies once 64 MB is waiting while `/proc/pressure/io` "some avg10" is at most 10%,
  or at 4 GB regardless (50 GB was free on 2026-10-10). It never copies a small log.

SQLite must own opening and closing its database and shared-memory lock files in this process.
The former raw `readFileSync(state.db-shm)` in the checkpoint thread closed a descriptor on
the shared lock inode every five seconds. POSIX close releases every lock this process holds
on that inode, including locks held by the accepting thread. SQLite cannot know its locks were
released; another process can enter a writer transaction concurrently. This is a confirmed
source defect and SQLite's [documented corruption hazard](https://sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_),
not proof of the exact writer overlap that damaged the database on October 10 at 12:24 ET.
The existing WAL sync descriptor remains open for the process lifetime; no lock file is
opened or closed to inspect checkpoint progress. NOOP requires SQLite 3.51.0 or newer;
the worker refuses older versions rather than letting an unrecognized mode run a checkpoint.
The installed server's Bun embeds SQLite 3.53.2. The candidate's existing SQLite constructor
gate also constrains this worker's filesystem calls to the lifetime WAL sync descriptor and
the unrelated pressure file; raw SHM inspection refuses the release.

## What still waits on the loop

Measured on 2026-10-10 12:55 ET after this change, under agent disk load (IO pressure 17-58%):
the owner's main thread was in uninterruptible wait 27% of a three-minute sample, with no
commit-sync waits left. Three causes, and what was done:

- **Scratch files.** SQLite sorts and temporary tables wrote files in `/var/tmp`, about three a
  second, and each create and delete waited on the root filesystem's journal (about 220 of 982
  blocked samples). The ledger connection uses `temp_store=MEMORY`, and the service sets
  `SQLITE_TMPDIR=/dev/shm` for every other connection in the process.
- **Account folder rescans.** Each usage read relisted every kept login and checked about thirty
  entries of `~/.claude` per account, 188 times in 15 s; path lookups waited on directory reads
  (177 samples). `account-files-memo.ts` serves those reads for two seconds; Concierge's own
  sign-in, switch and home preparation clear it at once.
- **Timestamp updates on ledger writes.** Every write to the log changes the file's modification
  time and version counter, and ext4 records that in its journal (`file_modified` →
  `ext4_dirty_inode` → `wait_transaction_locked`, about 465 samples). `lazytime` does not skip it
  on this kernel because the version counter forces an immediate inode update. Nothing inside
  SQLite avoids it. It ends only when ledger writes leave the owner's thread (the serialized
  executor) or the ledger's journal stops being shared with agents' writes (a filesystem of its
  own, for example an ext4 image on a loop device).

## The ledger's own filesystem

The third cause is answered by giving the ledger a journal agents never write into. remote-box
mounts a sparse ext4 image (`/var/lib/concierge-ledger.img`, loop device with direct I/O) at
`/var/lib/concierge-ledger` before Concierge starts (`remote-box-concierge-ledger.service`), and
Concierge's update moves `state.db` and `meaning-index.db` there once, while its drained
coordinator is stopped (`relocate_ledger_to_own_filesystem` in `bot/scripts/deploy.sh`): checkpoint,
copy, `quick_check` and page count against the original, then one rename swaps each file for a
link, with the original kept as `*.before-own-filesystem-<time>`. SQLite follows the link, so its log
and shared-memory files live beside the real file and every reader is unchanged. The step does
nothing when the filesystem is not mounted, when a file is still open, or when the move is done.
The empty mount point is immutable, so with the filesystem missing the link fails to open rather
than SQLite creating an empty ledger.

Measured before moving production (2026-10-10, scratch writers with the owner's settings, run side
by side under the same live agent load, kernel stacks sampled every 50 ms for four minutes):

| | own filesystem | root filesystem |
|---|---|---|
| preallocated image, IO pressure 19-62% | 0.4% blocked, no journal waits, p99 2 ms, 0 writes over 1 s | 35.2% blocked, 1,397 journal waits, p99 446 ms, 5 over 1 s |
| sparse image, IO pressure 64-66% | 2.0% blocked (dirty-page throttling only), p99 3 ms, 0 over 1 s | 52.9% blocked, 2,083 journal waits, p99 634 ms, 14 over 1 s |

The image's own writes to its backing file still pass through the root filesystem, but in the loop
device's kernel thread, not in the writer. Operation, growth and rollback are in remote-box's README
(Concierge ledger filesystem).

Rollout on 2026-10-10: remote-box's mount unit was deployed first and the image prepared (32 GB
sparse, loop device with direct I/O); the release that installed the move step went live at 18:49
UTC, and the update after it performs the move. The original files stay beside their links as
`*.before-own-filesystem-<time>` until the move has run for a day, then they are removed to return
their space (the root filesystem was at 98% that day).

The rare log-rewind header sync after a complete checkpoint also remains, placed after
quiet-disk checkpoints.

## Failure handling

The owner's connection switches to NORMAL only after the sync thread has opened its descriptor on
the log, so a writeback error after that point reaches the descriptor that vouches for it. From
then on it never returns to synchronous commits: that would put the disk wait back on the loop.
Only the sync thread that was open when a commit skipped its sync can vouch for it: Linux reports
a failed write-back to descriptors open at the time, so a replacement could report success over a
lost write. So once commits stop syncing, a sync thread that errors, exits or reports a failed sync
(including a replaced log file) ends the owner process with `ledger_durability_lost` (critical,
written synchronously to stderr) and exit status 75; systemd restarts it and it reopens the ledger
from what is actually on disk, which is the same recovery as the supervisor's kill. Nothing
unsynced was ever answered. A checkpoint thread that fails is replaced after five seconds
(`ledger_durability_thread_failed`, error); it proves nothing. Waiters are never released
without a confirmed sync and the barrier never rejects. A
sync that has not returned for a minute is logged as `ledger_durability_sync_stalled` (error) each
minute and is never treated as done. Stopping the request API leaves the threads running until the
process exits, so commits made while it drains still gate what leaves. `meaning-index.db` (a derived,
rebuildable index) commits with `synchronous=OFF` and is rebuilt from the ledger if it cannot be
opened after a crash; a power loss can leave it missing recent passages, which only narrows search
until those passages are indexed again.

## Signals

- `GET /supervisor/ping` → `ledgerDurability`: mode, sync count, slow syncs, slowest and last sync
  time, waiters, age of the sync in flight, unsynced changes, checkpoint counts. This is database
  completion latency, kept apart from the owner's loop lag (`owner_event_loop_lag`).
- `ledger_durability_slow_sync` (warn, sync ≥ 1 s), `ledger_checkpoint` (each checkpoint, with
  bytes, pressure and SQLite's result), `ledger_durability_started`, `ledger_durability_lost`, `ledger_durability_thread_failed`, `ledger_durability_sync_stalled`.
