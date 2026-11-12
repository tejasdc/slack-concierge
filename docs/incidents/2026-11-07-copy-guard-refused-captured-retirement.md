---
failure: Concierge refused its own safe recovery-copy retirement as if it were making a raw database copy.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Safe recovery-copy retirement was refused

## What was seen

On 2026-11-07, an agent tried to run Concierge's installed `--retire-captured` migrator for a
closed, verified pre-deployment recovery copy after the nightly off-box backup. The machine
PreToolUse copy guard refused it as a raw live-ledger copy. The guard inspected the migrator's
source, found its backup and schema code, and classified the whole script as a copy operation
even though this invocation selected only its retirement mode. The inherited-live package
launch check would have refused the same Bun command separately.

The exact recovery copy is `state.pre-deployment-repair.1793946599418.db`, 10,598,985,728
bytes, with a matching `.verified.json`. Both last changed by Nov 6 01:38:41 EST. The Nov 7
`remote-box-backup.service` run started 00:05:19 EST, finished 00:17:54 EST, and reported
inactive, success, exit status zero. Restic snapshot `17b234ee` lists the exact database and
verification record. The installed Concierge service was active after that update.

## Cause

The command guard inspected the retirement script's source and found backup and schema code.
It classified the whole script as a raw copy even though this invocation selected retirement
only. A separate inherited-live package-launch check would refuse the Bun command as well.

## Fix

The guard now recognizes one complete command to the current installed migrator with only
`--retire-captured`. The migrator keeps its own finished-backup and file-age conditions;
the guard still refuses raw copies, chained commands, additional migrator modes, and an
alternate artifact.

## Acceptance scenario

- **Seed:** A healthy promoted release and a closed, verified automatic recovery copy whose exact file and verification record appear in a completed offsite snapshot.
- **Action:** Run the documented installed retirement command through the managed agent shell.
- **Expected:** The hook admits that command, the installed migrator retires the eligible local copy, the offsite snapshot still lists it, and a raw ledger copy command remains refused.
- **Replayable offline:** yes (the generated machine-wrapper fixture exercises the guard with a fake installed release; the offsite and disk-space checks require the live host).
