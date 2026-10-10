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

The exact tail was exported read-only to `accepted-tail-private.json` in that private
incident directory (mode 0600): three turns, three inputs, 77 events, the communication
request and its target session. Read-only `thread/read` of the retained Codex thread
found the exact admitted provider turn completed with 129 items; it was checking an
unmerged draft session-history handoff, not an interrupted implementation. Its exact
completed provider record is preserved in `admitted-provider-turn-private.json`.
The other two inputs contain cancellation notices. None of the three exact inputs
exists in the restored ledger; this remains a retained history gap, not permission to
replay or overwrite its newer numeric identities.

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

## First normal installation

Run `6dab65b4-b878-447a-92bf-2ba028dceb4a` accepted the repair at 12:49:08 ET,
incorporated the later descendant `daa667b634bd63771d5520887de5df1b069860bd`
before activation, and succeeded at 12:54:09. Runtime manifest and systemd invocation
`fb123893fd284f62aad70e5cb98a53cf` agree on that installed commit, main PID 3459679.
The installed sealed checkpoint worker contains `wal_checkpoint(NOOP)` and no SHM
file access. Three continuing executions were adopted; the existing Inbox host PID
3239692 and provider PID 3239718 remained alive and attached.

At 12:54:32, the new invocation had five successful request completions, zero
request-database errors, no lock or malformed-database error and no durability-worker
failure. The waiting-capture route also answered successfully. This short window is
installation proof, not the final observation interval.

The predecessor immutable controller necessarily performed its old online migration
on this first upgrade. The next normal documentation delivery will exercise the new
controller's readonly backup → coordinator stop → schema-only → start ordering.
Final live evidence will be retained in the directly dispatched report and journal;
do not issue another rollout only to commit a final timestamp.

The documentation rollout `86f4679d-2711-4495-ac12-e5436bc14839` completed the
new read-only backup at 12:55:41 but refused activation at 12:57:41. The sealed
application check's disposable topic-owner initialization took 41.84 seconds and
both lifecycle fixtures hit their existing 45-second deadlines. Full host I/O
pressure was about 39%; no lock or corruption error was recorded. The runner
released both gates and retained the healthy repaired invocation; it never stopped
the coordinator. Pressure subsequently fell below 7% without this task stopping
another agent. This evidence delivery permits a normal fresh candidate assessment
under the changed resource conditions, with all deadlines and checks unchanged.

That fresh candidate assessment, run `cb8e30bd-cb54-4cf8-be0d-7a6a0ee0267c`,
also refused activation at 13:01:36 after a disposable dispatch-claim fixture hit
its 15-second deadline. Crucially, at 13:01:08 and :13, the *already upgraded*
coordinator logged two more `database is locked` message projections for turn
6670. The candidate's readonly backup had completed at 13:00:12, and the
coordinator had not stopped for schema migration. This disproves any claim that
the SHM and online migration fixes exhausted the incident. The exact competing
writer for this interval is not yet attributed; neither test fixtures nor the
later transient readonly CLI process may be called the cause from timing alone.
A bounded kernel lock census is recording the next held writer's PID and byte.

## Continued repair and exact reconciliation

A 180-second kernel census starting around 17:22 UTC observed 271 acquisitions and releases.
Live release helpers took the SHM writer lock even for `lkg` (1.159 seconds) and
`install-runtime` (0.825 seconds), because importing deployment state initialized schema and
the canonical connection set journal mode. A periodic key watcher also opened a writable
connection on no-change checks. These are confirmed unnecessary competing actors; no sample
from 17:01 identifies that interval's exact holder. Removing their initialization is a supported
fix, not proof of the historical PID or of eliminating every possible future SQLite busy result.

The continued patch gives schema setup to supervised coordinator startup and the stopped
migrator; ordinary helpers use existing schema and read commands use read-only connections.
The key watcher opens the database only for an actual change. Release fixtures hide the live
state directory in a private mount namespace with capabilities dropped. Canonical source
rehearsals refuse live state, and the existing command guard inspects named raw-copy scripts.
Verified staged backup publication and retention are described in the deployment runbook.

One bounded diagnostic snapshot of the restored owner was compared offline against the
unchanged preserved original by stable identities. The restored snapshot passed full
`integrity_check` and `foreign_key_check`. The 16:20:33–16:24:19 UTC gap has 18 exact input
identities absent from the restored snapshot (5 input, 4 action, 4 cancel, 3 reply, 2 request).
Of the 77 previously exported owner-event identities, 37 are present and 40 absent. Reused
integer IDs were not treated as proof of identity, and nothing was reinserted or replayed.

- Claude UUID `d628760e-bab4-4a3c-b056-3a34673b8f02`, input `saved-repeat:5865:2`,
  execution `299556185c7dab11`: exact result text and result-event bytes match and the restored
  owner marks completion delivered. Its original outcome action was lost and its timestamps
  reconstructed; the replacement outcome is `unsaid`.
- Codex request `dafe928e-5eb0-403e-af4a-5bd244c27ba3` completed in provider history.
  Its parent `870dd429-afb4-4108-8ff8-2977976144d7` was subsequently canceled by an agent,
  with a received cancellation result. The child result stays preserved, without replay or a
  new post into that canceled request. This is not evidence that the human withdrew the work.
- Requests `f6f6ca17-45e4-416e-9948-6fc10a2e49ce` and
  `f82a69ee-3502-4cdf-b885-9e8291ccf8a0` retain canceled outcomes. Their missing queued
  cancellation returns were not replayed.
- Request `22f2fe29-a253-4cc8-8b97-75909049c5e9`'s missing 16:23 event
  `50f8bb80-3490-4d27-bdee-19b4601b58cd` was progress. Its later final event
  `513452b0-f6a6-4e9e-b0e5-f486a229ff7c` is received and the request answered. The text
  differs; the missing progress is historical loss, not a pending final reply. The exact
  child exchange `1ff092f4-c175-4484-8d4c-f07d001cc279` is also absent; equivalence to the
  later parent answer is unknown.

The actual F1/F2 predicates found no incident-window human unbound input or waiting forwarded
reply without a request. The restored snapshot has six human inputs since the cut, all bound
to turns, and no waiting forwarded reply candidate. F1/F2 are confirmed source defects, not
demonstrated causes of this data gap. Their repair commits local acceptance with the queued
turn/request and retains explicit peer intent. Recovery refuses uncertain prior custody;
private fixtures exercise failures, exact retries, changed payloads and one queue claim.
Exact row evidence remains private under `/root/workspace/agent-scripts/dblock-reconciliation/`.
Final review and installed observation evidence are appended to the incident's working report;
this source record does not substitute for terminal deployment evidence.

### 14:05 failed start of 9fddf07a: the old control, not the new code

The 14:05 activation of `9fddf07a` failed in the unit's pre-start `control recover`
five times, and deployment repair restored `6f67b686`. The stack named
`releases/bcab255…/control/recover-deployment.js`, which is `6f67b686`'s control:
activation leaves the last promoted control in place until promotion, so the new
release's start ran the old control. `603b7abc` (in `6f67b686`) opened the existing
ledger with `{ create: false }`, and Bun 1.4.2 refuses that with `SQLITE_MISUSE`
unless `readwrite: true` is also given (reproduced on a scratch file; `{ readwrite:
true, create: false }` and `{ readonly: true, create: false }` both open). The
"anonymous database in read-only mode" lines in the journal are Bun's printed source
context around the throwing call, not the error; no path was empty and nothing
opened `:memory:`. `5df2d22a` already fixed the open, and its fixture now covers a
non-schema writable entrance. Repair's cutover moved control to `9fddf07a` at 14:05,
whose `recover` then ran clean at 14:06:07, so the next start uses fixed control.
Until a release containing `5df2d22a` is current, the minute-by-minute native
continuation bundled in `6f67b686` keeps failing with the same `SQLITE_MISUSE`.
This entry's push is the fresh run that installs it.
