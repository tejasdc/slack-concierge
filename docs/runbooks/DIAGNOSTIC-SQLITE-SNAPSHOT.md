# Diagnostic SQLite snapshots

Use `scripts/diagnostic-sqlite-snapshot.py` to copy **one** SQLite database for an offline
investigation. Pass absolute paths to an existing source database and a destination that does
not exist:

```sh
python3 scripts/diagnostic-sqlite-snapshot.py /absolute/source.db /private/diagnostic-copy.db
```

The command opens the source read-only, requires WAL mode, pins a committed read snapshot,
and uses SQLite's native backup API to copy in bounded steps. Concurrent writers can continue;
the pinned read snapshot holds WAL checkpoint history until the command ends. The default
limits are 120 seconds and 8 GiB of database pages; `--max-seconds` and `--max-bytes` can
lower or raise them for a known diagnostic. The command checks its deadline between backup
steps, not while one SQLite step is running. Stop a wedged process at the operator boundary.
The copy still reads the whole database through the shared disk; these limits bound that
competition rather than removing it.

The output is staged in a private directory beside the requested destination, with file mode
0600. A complete copy is published atomically without replacing an existing path. Failure
removes the staged database and sidecars, closes both SQLite connections and releases the
read snapshot. A process killed by a signal may leave its private
`.sqlite-snapshot-*` staging directory; no partial destination is published, and the OS
releases its source read lock. Inspect and remove that staging directory separately.
Use a private destination directory because the destination inherits its
parent's directory access. Do not use the raw `sqlite3 .backup` command for a live source;
that command can restart its copy when writes occur between steps. See the
[SQLite backup API](https://www.sqlite.org/backup.html) and
[Python's backup parameters](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.backup).

Each invocation represents one database cut. Running this command separately for two
databases does **not** produce a shared point in time. The agent command guard refuses direct
raw copies and named copy scripts; the canonical ledger module refuses ad-hoc live rehearsal
imports. Candidate release checks have an OS boundary making the live state inaccessible.
The diagnostic script itself is an operator entrance, not a universal restriction on an
unrestricted root shell. Its output is forensic evidence rather than a verified deployment
rollback copy. Deployment backup publication and verified retention are owned by the
[deployment runbook](DEPLOYMENT.md#state-migration-and-backups).
