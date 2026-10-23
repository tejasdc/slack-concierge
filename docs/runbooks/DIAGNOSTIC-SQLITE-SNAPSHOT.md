# Diagnostic SQLite snapshots

Use `scripts/diagnostic-sqlite-snapshot.py` to copy **one** SQLite database for an offline
investigation. Pass absolute paths to an existing source database and a destination that does
not exist:

```sh
python3 scripts/diagnostic-sqlite-snapshot.py /absolute/source.db /private/diagnostic-copy.db
```

The command opens the source read-only, requires WAL mode, pins a committed read snapshot,
and uses SQLite's native backup API to copy in bounded steps. Concurrent writers can continue;
the pinned read snapshot holds WAL checkpoint history until the command ends, and the copy
reads the source exactly once even while it is being written (measured 2026-10-23 with a
writer committing every 5 ms). The default
limits are 120 seconds and 8 GiB of database pages; `--max-seconds` and `--max-bytes` can
lower or raise them for a known diagnostic. The deadline covers the whole copy, including
writing it to disk, and is checked between backup steps, not while one SQLite step or flush
is running. A deadline failure names how much was copied so the next attempt can size
`--max-seconds` instead of killing the copy.

**The copy is written through to disk as it goes, 32 MiB at a time.** Each piece is flushed
and dropped from the page cache before the next is copied, so the shared filesystem never
holds more than about 32 MiB of unwritten copy data. That matters because every fsync on the
filesystem (the ledger's own durability sync reaches it through the loop device's flush)
waits for all dirty, journal-ordered data, whoever wrote it. On 2026-10-23 the earlier
version, which flushed only at the end, copied the 5.4 GB ledger into `/tmp` under the
agents' 30 MB/s disk write cap: the whole copy sat dirty for three minutes, the owner's
durability sync took 35 s, a ledger write on the owner loop blocked 31 s, thnkr.ing lost the
owner 24 times, and Grafana's pressure rule fired
([failure record](../incidents/2026-10-23-ledger-snapshot-copy-stalled-the-owner.md)).
The copy still reads the whole database through the shared disk and still writes it at the
disk's (or the caller's cgroup's) pace; under the agent write cap the ledger takes about
three minutes, so pass `--max-seconds 300` or more for it. Killing a copy does not take back
the pieces already written; with write-through there is at most one piece left to drain.

The output is staged in a private directory beside the requested destination, with file mode
0600. A complete copy is published atomically without replacing an existing path. Failure
removes the staged database and sidecars, closes both SQLite connections and releases the
read snapshot. `SIGTERM` (a plain `kill`) is the clean stop: the command raises its own
failure, removes its staging directory and exits 1 saying it was stopped. Only `SIGKILL`
leaves the private `.sqlite-snapshot-*` staging directory behind; no partial destination is
published, and the OS releases its source read lock. Inspect and remove that staging
directory separately.
Use a private destination directory because the destination inherits its
parent's directory access. Do not use the raw `sqlite3 .backup` command for a live source;
that command can restart its copy when writes occur between steps. See the
[SQLite backup API](https://www.sqlite.org/backup.html) and
[Python's backup parameters](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.backup).

Each invocation represents one database cut. Running this command separately for two
databases does **not** produce a shared point in time. The agent command guard refuses direct
raw copies and named copy scripts at every place a live store really is: the state directory and
wherever its database links point, such as the ledger's own filesystem at `/var/lib/concierge-ledger`,
reached through any link, `..` detour or hard link to the same file. It reads those links on each
command, so a future move needs no change to the guard. The canonical ledger module refuses ad-hoc live rehearsal
imports. Candidate release checks have an OS boundary making the live state inaccessible.
The diagnostic script itself is an operator entrance, not a universal restriction on an
unrestricted root shell. Its output is forensic evidence rather than a verified deployment
rollback copy. Deployment backup publication and verified retention are owned by the
[deployment runbook](DEPLOYMENT.md#state-migration-and-backups).
