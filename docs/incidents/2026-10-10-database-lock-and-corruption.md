# October 10: database locks and damaged ledger

Requested investigation: server lock errors causing visible session and Inbox failures;
identify the writer, repair the design, retain running agents, independently review,
deploy normally and check live. The directly dispatched outside agent began at 12:19 ET
because Concierge could not reliably record or launch its repair agents.

## Confirmed evidence

- At 12:08:04, :09 and :14 ET, main PID 3173334 failed provider-message projections for
  turns 6616, 6583 and 6624. Each failed insertion waited about five seconds. No recorded
  deployment covered this interval; the historical lock holder PID is not recoverable.
- At 12:21:29–:45 ET, `/proc/locks` samples caught exclusive WAL-index write locks at
  byte 120 from coordinator PID 3252256 and deployment processes including migrator
  3259764, installer/control 3275069 and 3275348, and release-manager 3276184. The
  migrator reserves the writer around both schema imports while the service is active.
- The checkpoint worker runs in a thread inside the coordinator process. Its former
  `readFileSync(databasePath + '-shm')` opens and closes the shared lock inode every
  five seconds. POSIX close releases **all process locks on that inode**, including
  another thread's WAL writer lock. SQLite documents this corruption hazard:
  [POSIX lock cancellation](https://sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_).
- A disposable Bun/SQLite 3.53.2 reproduction held `BEGIN IMMEDIATE`, then asked a
  separate SQLite process to acquire it. That process was blocked initially and after
  SQLite `wal_checkpoint(NOOP)` inspection, but acquired it after the old raw SHM read.
  This proves the source defect. It does not prove the exact 12:08 writer or the exact
  overlap that damaged production.
- The real patched checkpoint worker completed three ticks while a scratch owner's
  write transaction was held; a competing process remained excluded at each tick and
  could acquire the writer after rollback. The candidate constructor gate accepted the
  safe worker and rejected restored raw SHM access; independent review also checked
  filesystem alias escape and changed WAL path rejection.

The [separate page-load investigation](2026-10-10-page-load-diagnostic-copy.md)
identified and stopped an orphaned incremental backup at 12:17:31 ET. It was read-only
on the source but wrote over 52 GB repeatedly and caused severe disk pressure. It is
not itself identified as the competing SQLite writer.

At 11:58, capture delivery failed with `Capture queue claim failed: 200`; the request
surface closed at 11:58:48 and returned after restart at 11:59:19. No lock error was
recorded from 11:55 to 12:00. The recording's waiting-capture error is consistent with
that interruption; its exact browser request is unavailable, so attribution remains
likely rather than confirmed. The “Being sorted” state has not been separately proved.

## Emergency recovery and retained gap

A separate deployment's migrator passed its full consistency checks at 12:21:37 ET.
At 12:24:13 the restarted coordinator reported `SQLITE_CORRUPT`; its startup recovery
subsequently failed and systemd stopped retrying at 12:24:56. The cause of that exact
damage is unconfirmed. The original and WAL/SHM were retained under
`/root/.local/state/concierge/incidents/2026-10-10-1224-corrupt/`.

The preceding backup `state.pre-deployment-repair.1791649233269.db` passed a separate
`quick_check(1)`. With the service already failed and no coordinator running, it was
copied to a temporary destination and atomically installed. The stopped service started
at 12:32:07, was online at 12:32:12, and adopted eight existing agent executions. This
was emergency data recovery, not the lock patch's deployment or acceptance proof.

The damaged original's maximum turn was 6640 versus backup 6637, and its event high-water
mark was 367738 versus 367661. Retained missing work includes admitted Codex turn 6638
(session 5069, input `request:dafe928e-5eb0-403e-af4a-5bd244c27ba3`, provider started
16:21:41 UTC) and two queued service returns to session 3172 (`return:1c17d29e-dec2-46c1-b30d-73b2151a2109`
and `return:27c73adb-d65d-423c-bdd2-89159989e659`). The restored ledger reused numeric
turn labels for different identities. Never copy these rows by numeric ID or replay the
admitted request. Exact request/input identities and provider transcripts must be used
for reconciliation. The original request row is absent from the restored ledger; this
gap is retained, not claimed recovered. Some commands acknowledged between backup and
damage may also have uncertain effects.

## Repair boundary

Checkpoint progress now uses SQLite's NOOP query, which reports frames without copying
them or opening the lock inode outside SQLite. The release gate restricts the durability
worker's filesystem capabilities. See [ledger durability](../architecture/LEDGER-DURABILITY.md).

Verified backup and candidate build remain online. Additive schema work occurs only
after the normal coordinated drain has stopped the coordinator, with a systemd inactive
check before opening the migrator's writer. Agent hosts survive and are adopted at the
next start. This removes the observed long migration writer while preserving existing
external recovery ownership; it does not claim all external controls are owner-socket
commands. See [migration ordering](../runbooks/DEPLOYMENT.md#state-migration-and-backups).

Deployment and final live evidence remain pending.
