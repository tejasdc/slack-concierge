---
failure: Verified deployment repair backups accumulated until the server root disk fell below its 50 GB free-space floor.
date: 2026-10-23
fix_commits: []
cause_status: confirmed
---

# Repair backups held root disk space

## What was seen

At 11:40 ET, `/` had 48 GB free and was 89% used. Four automatic pre-deployment-repair
backups occupied about 17 GB. The oldest three were from October 15–16; the newest was
created October 23. Every copy had a matching verification record.

## Cause

The deployment backup owner kept up to eight verified copies under a 16 GiB total cap.
All four copies fit that policy, so its pruning routine correctly left them in place
despite the server crossing the disk free-space floor.

## Fix

Keep at most the newest two verified automatic copies under 12 GiB, always preserving
the newest. Run this retention check on schema-free deployments as well as after a
new verified backup is published. The explicit prune-only entrance lets an operator
reclaim already superseded copies without creating another whole-ledger backup.
Historical manual and unverified safety copies outside the automatic naming pattern
remain untouched.

## Acceptance scenario

- **Seed:** Four automatic backups with valid identity-matched verification records, plus an unrelated manually named backup. Make the newest copy larger than the older ones.
- **Action:** Run automatic retention during a schema-free deployment.
- **Expected:** The two newest verified automatic copies and the manual copy remain. The two oldest verified automatic copies and their records are removed; no new backup is created.
- **Replayable offline:** yes (use small synthetic SQLite backups and matching verification records).
