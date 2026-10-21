---
failure: An agent made raw copies of Concierge's live database at its new location, which the copy guard did not recognise; the copy wrote 10.7 GB and slowed Concierge down.
date: 2026-10-16
fix_commits: [feeadd31]
cause_status: confirmed
---

# An agent's raw ledger copy got past the copy guard and slowed Concierge

## What was seen

At 23:56:49 ET on 2026-10-15 a Claude agent in the Thinkering project (Concierge session 6727,
"Focus modes with checkpoints, tracked as habits") ran
`sqlite3 /var/lib/concierge-ledger/state.db ".backup /root/workspace/thinkering/tmp/focus/ledger/state.db"`,
and then a plain `cp` of the same file with its `-wal` and `-shm`. The guard refused neither.
In 7 minutes the backup wrote 10.7 GB but reached only 152 MB of the 4 GB ledger, because a backup
restarts under live writes (the October 10 pattern). Disk pressure sat at 50-57%, the agent unit
wrote at its cap, and the outside monitor reopened incident fa772103 ("Concierge is slowing
down"). The repair agent killed that sqlite3 process at about 00:04 ET.

## Cause

On 2026-10-10 the ledger moved to its own loop-mounted filesystem at `/var/lib/concierge-ledger`
(8c851bc9, `bot/scripts/relocate-ledger.ts`). The state directory keeps links to the moved files.
The machine copy guard (`liveStoreCopyRefusal` in `bot/src/live-store-copy-policy.ts`, installed
machine-wide and in effect) recognised live stores only by text: the old
`~/.local/state/concierge` path or `$CONCIERGE_STATE_DIR`. A command naming the real file under
`/var/lib/concierge-ledger` matched none of those, so it was treated as an ordinary file. The
fixture tested only the old path.

## Fix

feeadd31 makes the guard derive live locations from the one place that defines them. `liveStores()`
reads the state directory and follows each database link to its real home, collecting every live
directory and the device/inode of every live database and WAL. Each path argument in a command is
canonicalised and refused when it resolves inside a live directory or is the same file as a live
database, so links, `..` detours and hard links reach the same answer, and a future move needs no
guard change. Read-only queries and the bounded snapshot entrance stay allowed. Both fixtures cover
a relocated ledger; `docs/runbooks/DIAGNOSTIC-SQLITE-SNAPSHOT.md` was updated. The related hardening
064573bf hides the same real location from the release-check sandbox; no live access through that
path was observed. 2026-10-10-page-load-diagnostic-copy.md is an earlier copy of the old path, a
different event.

## Acceptance scenario

- **Seed:** A state directory whose `state.db` is a link to a database on another directory (or
  filesystem), plus a hard link and a `..` path to the same file, with the guard installed.
- **Action:** Submit `sqlite3 <real path> ".backup /tmp/x.db"`, then `cp <real path> /tmp/x.db`.
- **Expected:** Both are refused with the snapshot-entrance message, through every alias.
  `sqlite3 -readonly <real path> "SELECT count(*) …"` is allowed.
- **Replayable offline:** yes (scratch directories and the guard fixture; no live ledger needed)
