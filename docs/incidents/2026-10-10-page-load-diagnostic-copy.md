# October 10: page loads stalled during an orphaned diagnostic copy

User report: "yo it broke again dont know what happened this time", clarified as pages
failing to load, then beginning to load again. Investigation: 16:13–16:21 UTC.

## Confirmed observations and recovery

- Concierge and Thinkering had already restarted at 16:12:21 and 16:11:41. Provider
  launches continued; the October 8 silent claim defect was not observed. Page status
  requests nevertheless reached 20-second 503 timeouts and an 18-second successful response.
- Agent diagnostic PID 3077970, started 15:36:54, ran a raw SQLite `.backup` of the live
  2.3 GB ledger. It was orphaned (parent 1), in execution unit `950b732c88c778e5`, with cwd
  `/tmp/rehearse-5104`. Its destination and journal were already unlinked but still open.
  `/proc` showed 52,784,283,648 physical bytes written; two samples measured 31.8 and
  28.9 MB/s. Host I/O pressure full/avg10 reached 72.50%, with application and filesystem
  journal processes blocked on disk. Disk occupancy was 98% with 9.6 GB available.
- After independently verifying its exact command, cwd, open destination and execution
  group, the outside recovery agent sent TERM only to PID 3077970 at 16:17:31. It exited.
  No provider, service or live ledger was stopped, edited or restored. The already-deleted
  unfinished diagnostic destination had no published copy to preserve.
- By 16:18:52, full I/O pressure avg10 was 4.18%; free space was about 12 GB. Four recorded
  page reads since 16:18 all returned 200: session view 9.681 ms, topic entries 9.247 ms,
  history 1033.511 ms, session view 12.138 ms. Both application PIDs remained unchanged.
  This strongly supports a major contribution from the copy, not a controlled proof that
  every page failure or remaining stall has the same cause.

The separate rehearsal PID 3196465 retained a read-only source descriptor and a scratch
presentation database. Its measured writes were much smaller (610 KB over two seconds);
it was not terminated or its scratch output removed. The owning session was notified under
request `98379e53-b8b0-49b7-949f-b8d39c3cdfdb`; Inbox coordination is retained under
`2d49fdc1-e5ea-45c1-aa48-4fb85392502b` and `73900e2f-5333-4eb4-8dce-4c105d98620d`.

## Existing prevention and limits

The [bounded snapshot entrance](../runbooks/DIAGNOSTIC-SQLITE-SNAPSHOT.md) already pins a
source snapshot and bounds copying. Raw live `.backup` bypassed it. SQLite documents that
external source changes can restart an incremental backup; this can keep rewriting a busy
source indefinitely ([upstream contract](https://www.sqlite.org/backup.html)). No new backup
framework or runtime restart was justified to stop this abandoned copy.

The agent slice's existing 30 MB/s aggregate write cap was present but did not prevent this
incident. It must not be described as proof that agent work cannot stall pages. The snapshot
entrance is an operator tool, not an OS prohibition on arbitrary live-database reads. Durable
prevention of bypasses and orphaned diagnostic descendants remains an owner-level gap, not
something this recovery has enforced by adding another instruction.

Two fast topic-list 400 responses also occurred with zero database calls. Their exact query
and user impact were not established; they are not attributed to disk wait. No source patch,
automated test suite, production database copy or replay of uncertain work was performed by
this investigation. Independent Sol evidence is retained in the uncommitted review artifact.
