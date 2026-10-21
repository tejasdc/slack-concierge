---
failure: Pre-update database copies were kept long after they were useful, filling the server disk so ChatGPT requests failed and later pushing it below its free-space floor.
date: 2026-10-09
fix_commits: [f9952bc9, 4068fd1b]
cause_status: confirmed
---

# Kept pre-update copies filled the server disk

## What was seen

On October 9 twenty kept 1.9 GB copies (38 GB) left 17 GB free; at 18:09 the hourly Thinkering backup's temporary
snapshot filled the disk and ChatGPT sends failed with "no space left". The repair agent pruned to eight by hand. On
October 12 seven 2.4 GB copies from October 10 still sat beside six certified ones and took the root disk under its
50 GB floor. This is about how many copies were retained; how often a copy was made is the separate
[full-copy-every-update record](2026-10-10-updates-copied-full-ledger-filled-disk.md).

## Cause

Retention in `bot/scripts/migrate-deployment-repair.ts` kept twenty automatic copies. After verification certificates were
introduced (`bot/src/verified-sqlite-backup.ts`), retention counted only certified copies, so copies made before
certificates existed were never counted and never removed.

## Fix

f9952bc9 lowers the kept count from twenty to eight. 4068fd1b removes an unverified automatic copy once a newer verified
copy exists (leaving newer or still-publishing ones alone) and bounds verified copies to eight and 16 GB, always keeping
the newest; `bot/scripts/database-safety-fixture.ts` covers both rules.

## Acceptance scenario

- **Seed:** A backups folder with ten certified copies totalling over 16 GB, plus five older uncertified copies and one
  uncertified copy newer than every certified one.
- **Action:** The update's backup step publishes one new verified copy.
- **Expected:** At most eight certified copies and at most 16 GB remain (newest always kept); the five older uncertified
  copies are gone; the newer uncertified copy remains.
- **Replayable offline:** yes (scratch backups directory with small stand-in files and certificates)
