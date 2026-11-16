---
failure: The ledger's write-ahead log stopped rewinding and grew by gigabytes, filling the server's root disk.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# Server root disk losing several GB an hour to the ledger log

## What was seen

On 2026-11-15 the AX41 rapid-disk-loss alert fired (9:55 AM ET). The repair agent
(concierge:9640) and its outside investigator (concierge:9747, GPT-6.1 Sol) traced continuing
allocation to the ledger's write-ahead log inside its loop image: the log grew while the database
stayed flat, and the `ledger_checkpoint` series ran from 04:56 to 20:41 UTC without the log
rewinding, to 3,457,925 frames (about 14 GB). On 2026-11-16 at 06:25 UTC the image was still
growing about 30 MB a minute with about 5 GB free on root.

## Cause

The checkpoint thread copied the log with PASSIVE only once 64 MB was uncopied. PASSIVE copies up
to the frame it saw when it started; commits made while it ran stayed behind as a small tail,
though it reported `log == checkpointed` for its own snapshot. SQLite rewinds the log only when a
writer starts with every frame copied, and the tail then waited for another 64 MB, so the log
rewound only when a copy happened to overlap no commit. 16,215 shared-memory header samples
captured one such cycle (61 frames committed during a 1.6 s copy); no stuck reader was needed.

## Fix

The checkpoint thread finishes a partly copied generation's tail on its next tick with PASSIVE,
never taking the writer lock. (A FULL fallback shipped first in 6c982e7a was removed because it
held the writer lock against the owner's commits.) Rewinding is likely, not guaranteed: at 60
commits/s on a disposable ledger PASSIVE tail copies did not rewind. See `docs/architecture/LEDGER-DURABILITY.md#log-recycling-before-owner-admission-history`.

## Acceptance scenario

- **Seed:** a WAL-mode SQLite database with the owner's settings (`synchronous=NORMAL`,
  `wal_autocheckpoint=0`, 5 s lock wait) and the checkpoint worker with thresholds scaled to
  1 MB/4 MB and the pressure gate open.
- **Action:** commit a 6 KB row 15 times a second for 40 seconds.
- **Expected:** the log rewinds repeatedly and stays under a few hundred frames; every row reads
  back. Before the fix it rewound rarely and grew past 1,300 frames.
- **Replayable offline:** yes
