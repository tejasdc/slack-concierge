---
failure: A release with no schema change stopped Concierge, then failed on a redundant schema read and repeatedly retried while repair owned the run.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# A no-change release stopped Concierge and hit a database lock

## What was seen

Release run `ab3d331f-fdd2-43ab-8f32-a3ba46efd933` planned candidate `305faddc` at
02:47–02:50 UTC. Its online schema comparison returned `no_schema_change` with no backup.
After the controller stopped Concierge at 02:50:15, the candidate migrator repeated the
schema comparison and failed with `SQLITE_BUSY` at 02:50:22. The controller restored the
last known good release. Its transient unit retried every ten seconds while the durable
run was in `releasing` with repair ownership; the repair supervisor later parked the run
as failed and the unit stopped. The installed release remained `342baaba`.

The retained log does not identify the process holding the SQLite lock or the extended
SQLite error code. The lock's origin remains unknown. The redundant offline read and
the repeated runner launches are confirmed by the controller source, run ledger and
systemd journal.

## Cause

The controller treated an absent backup path as a reason to repeat the candidate's
schema comparison after stopping Concierge, although the online comparison had already
shown no schema change. With no schema work to apply, this read could fail and keep the
owner offline for no migration benefit. After recovery assigned the same durable run to
the repair supervisor, a claim refusal exited nonzero, and systemd restarted the old
runner despite its lost ownership.

## Fix

The candidate migrator recognizes a managed no-change deployment and returns unchanged
without touching the ledger during the offline phase, including when the previous pinned
controller still invokes it. The new controller treats the online no-change result as
complete and checks that every other result has a backup path before the stop. Releases
with schema changes retain their verified backup and offline migration. A retrying old
runner exits successfully when the repair supervisor owns the durable run; only a durable
transition back to retrying permits a new claim.

## Acceptance scenario

- **Seed:** A managed release whose candidate schema already matches the live ledger; the
  schema read would meet a SQLite lock after the service stop. A separate run has repair
  ownership while its old transient unit restarts.
- **Action:** Deploy the first release and let the old unit attempt its claim.
- **Expected:** The no-change release skips the second schema read and reaches candidate
  startup; the repair-owned old unit exits successfully without reclaiming or repeating
  deployment. A release with a changed schema still verifies a backup and migrates offline.
- **Replayable offline:** yes (with a scratch ledger and managed-run environment).
