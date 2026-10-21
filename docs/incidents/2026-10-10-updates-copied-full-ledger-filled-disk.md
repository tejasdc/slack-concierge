---
failure: Every update wrote a full 2.3 GB copy of the database, so ten updates in 90 minutes filled the server disk to 99%.
date: 2026-10-10
fix_commits: [e9b85ba8]
cause_status: confirmed
---

# Updates copied the full database every time until the disk was nearly full

## What was seen

On October 10 the server disk reached 99% after ten ledger copies in about 90 minutes, and the copying added gigabytes of
writes per hour on the disk whose contention already stalls the owner. This is a different cause from the orphaned
diagnostic backup in [the page-load record](2026-10-10-page-load-diagnostic-copy.md) (52 GB, an agent's raw `.backup`) and
from [the lock and corruption record](2026-10-10-database-lock-and-corruption.md); neither covers the update-time copy.

## Cause

The deployment migration step (`bot/scripts/deploy.sh` calling `migrate-deployment-repair.ts --backup-only`) took a verified
`VACUUM INTO` copy of the 2.3 GB ledger before every update, whether or not the release changed the schema. Pruning to the
eight-copy limit ran only after a migration that succeeded, so copies from updates that failed later were never pruned and
ten stood on disk against a limit of eight.

## Fix

e9b85ba8 makes the copy conditional and the pruning unconditional:

- `--backup-if-needed` runs from the release being installed. It builds that release's schema in a scratch database (a child
  with `--empty-schema`) and compares it with the live ledger: missing tables or columns, and indexes, triggers or views that
  are missing or differ. No difference prints `no_schema_change` and copies nothing.
- `--schema-only` with no backup path re-checks with the coordinator stopped, copies first if a difference appeared, and
  otherwise exits `unchanged` without the whole-ledger checks. `--plan` prints the comparison read-only.
- Copies are pruned before each new one, keeping room for it, so failed updates no longer accumulate more than eight.
- A release whose migrator predates `--backup-if-needed` is still copied unconditionally. `docs/runbooks/DEPLOYMENT.md`
  documents the flow.

## Acceptance scenario

- **Seed:** A live-shaped ledger and a release whose schema matches it; separately, a release adding one column; eleven stale
  automatic copies in the backups folder.
- **Action:** Run the update's migration step (`--backup-if-needed`, then `--schema-only`) for each release.
- **Expected:** The matching release writes no copy and reports `no_schema_change` then `unchanged`; the column-adding release
  writes exactly one verified copy; after either, no more than eight automatic copies remain and total backup bytes do not grow
  on the unchanged case.
- **Replayable offline:** yes (scratch state directory with a generated ledger; no live disk or service required)
