---
failure: An agent's diagnostic copy of the 5.4 GB ledger, made with the repository's own snapshot command, left the whole copy as unwritten data on the shared disk and froze Concierge for 31 seconds while it drained.
date: 2026-10-23
fix_commits: []
cause_status: best-explanation
---

# Concierge froze for half a minute while an agent copied the ledger for diagnosis

## What was seen

At 21:39:20 UTC on 2026-10-23 the work-flow supervisor opened incident
`75680872-6080-4533-8aed-763af6329746` (`owner_loop_blocked`, `host_resource_pressure`,
lag 31.9 s in five minutes). Concierge's own log shows one `owner_event_loop_lag` of
30,676 ms with 71 ms of CPU: a single ledger statement from the watch worker (the
`UPDATE watches …` in `markObserved`) occupied the owner loop for 30,831 ms. The busy
timeout is 5 s, so this was a kernel-level block on the write, not a lock wait. At the
same instant `ledger_durability_slow_sync` reported a 35,055 ms fdatasync, remote-box's
per-minute disk sampler took 77 s for one sample, thnkr.ing logged
`SESSION_OWNER_UNAVAILABLE` 24 times and gave up a `session.peer-attach` after 135 s,
and Grafana's `AX41ResourcePressure` rule fired (delivered 21:40:02, resolved 21:45:02).

## Cause

Concierge execution `51a248e3335eb2a6` (a Codex `exec` run, GPT-6 Sol, session
`concierge:7403` "Repair phone Inbox send refusals") ran at 21:36:14:

```sh
python3 scripts/diagnostic-sqlite-snapshot.py /var/lib/concierge-ledger/state.db /tmp/phone-409-state-7403.db --max-seconds 120
```

The command copied all 5.36 GB into its staging file within the first minute (the file's
modification time is 17:36 local), entirely into the page cache, and then flushed it once at
the end. The run lives in `agents.slice`, whose disk write cap is 30 MB/s, so the dirty copy
drained for three minutes: remote-box's `io_by_owner` shows `concierge-exec` writing 1.25,
1.9 and 2.2 GB in the three samples ending 21:37:00, 21:38:03 and 21:39:20. The agent
killed the copy at 21:37:38 (`kill`, ignored) and 21:38:02 (`kill -9`, exited 21:38:31
with the staging directory and its 5.36 GB left in `/tmp`); killing changed nothing,
because the data already written still had to drain.

The root filesystem is ext4 in its default ordered mode. The ledger lives on a loop device
whose backing file is on that filesystem, so the ledger's durability fdatasync reaches the
root filesystem's journal through the loop device's flush, and an ordered-mode journal
commit waits for every dirty data block in the transaction, whoever wrote it. Everything
that waited on a root-filesystem flush was therefore held until the throttled copy
finished draining at 21:39:20: the durability thread, the owner's WAL append (it needs a
journal handle while the journal is committing), remote-box's sampler, Thinkering's
requests to the owner, and the agent's second snapshot (of the capture database), which
returned "deadline exceeded" at 21:39:21 after 127 s against a 60 s limit. All of them came
unstuck in the same second. The coupling mechanism is the best explanation (it matches the
per-thread stack sampling of 2026-10-17); the dirty-data accounting and the timing are
confirmed. The 23 GB read by the same unit in the minute to 21:37:00 is likely the agent's
`rg` over Thinkering's 31 GB agents folder plus the 5.4 GB source read; the copy itself
reads the source once (measured).

## Fix

`scripts/diagnostic-sqlite-snapshot.py` now writes the copy through to disk 32 MiB at a
time (`fdatasync` on the staged file, then `POSIX_FADV_DONTNEED`), so the shared filesystem
never holds more than about 32 MiB of unwritten copy data and the copy no longer evicts the
serving process's page cache. The deadline now covers writing as well as copying and the
failure names how much was copied. `SIGTERM` is handled as a clean stop that removes the
staging directory. The runbook says the ledger needs about three minutes under the agent
write cap and that killing a copy does not take back what was written.

Measured on 2026-10-23 with a 631 MB WAL source copied to the root filesystem: the earlier
version left 629 MB dirty at its peak; the new one at most 34 MB; a plain `kill` mid-copy
now exits 1 with "stopped by signal 15" and leaves no staging directory.

Not changed here (host configuration, remote-box's, and machine-wide resource changes need
Tejas's approval): the agents' write cap, which turns a 5 GB flush into a three-minute one,
and the loop-mounted ledger's dependence on the root filesystem's journal.

## Acceptance scenario

- **Seed:** a WAL-mode SQLite database of at least 500 MB in `/dev/shm`; a destination
  directory on a real disk; the caller's cgroup `memory.stat` readable.
- **Action:** run `scripts/diagnostic-sqlite-snapshot.py <source> <destination>` and
  sample the caller cgroup's `file_dirty` every 20 ms until it exits; then run it again and
  send `SIGTERM` once a third of the source has been written.
- **Expected:** the first run exits 0 and `file_dirty` never rises more than 64 MiB above
  its baseline; the second exits 1 with "stopped by signal 15", publishes no destination and
  leaves no `.sqlite-snapshot-*` directory.
- **Replayable offline:** yes (no live database or Concierge needed; the probe used on
  2026-10-23 is `~/workspace/agent-scripts/snapshot-pacing-probe.py`).
