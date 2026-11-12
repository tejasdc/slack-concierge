---
failure: A SQLite lock stopped the attachment receipt release during an offline schema check.
date: 2026-11-05
fix_commits: []
cause_status: best-explanation
---

# Offline schema read refused during attachment receipt release

## What was seen

The normal deployment of `305faddc5f1376f42c989955b07561cc7ca4dfe3`
prepared and activated candidate artifact `3244783b45bcf96fa1a0cc4166027366cac7ce13dd70323559e62a6353ace1cd`.
Its pre-stop schema comparison found no change. The controller stopped
`concierge-bot.service` successfully at 2026-11-06 02:50:15 UTC, then the
candidate's post-stop read of `sqlite_master` failed at 02:50:22 with
`SQLITE_BUSY` (Bun `errno: 5`) while preparing the read. This was before any
candidate schema migration or execution of the retained held message. The candidate was restored to
the last-known-good application revision `342baaba17c7da5567d19e5c12750e8b5cc62950`.

Deployment run `ab3d331f-fdd2-43ab-8f32-a3ba46efd933` temporarily remained in
`releasing` while its transient unit retried a claim that the owner refused.
The existing autonomous repair recorded incident
`232a6651-9861-47e1-8580-4722692edbcb` and parked the run at 02:57:04 UTC.
The restored owner and capture delivery were healthy; the attachment metadata
contract was not installed at that observation.

## Cause

The lock holder was not retained. SQLite documents that a WAL reader can receive
`SQLITE_BUSY` during another connection's final close or recovery, but this
incident does not establish which case occurred.

The repeated old-runner launches have a separate confirmed cause. Once the
repair supervisor owned the nonterminal run, the claim guard correctly refused
the old runner. That refusal exited nonzero, so systemd's failure policy
started the same transient unit again every ten seconds until repair parked
the run as failed.

## Fix

The correction retries only the
read-only full schema scan on a fresh connection after a busy refusal. If all
three scans fail, the release still fails and the controller restores the proven
last-known-good revision. No retained upload or Send is replayed by this change.

The claim response now reports repair ownership to the old runner without
granting it a claim. The runner exits successfully, while the durable run stays
with the repair supervisor. Only a reviewed transition to `retrying` permits
another claim.

## Acceptance scenario

- **Seed:** A candidate release with a healthy last-known-good revision and a read-only schema scan that receives `SQLITE_BUSY` once.
- **Action:** The ordinary deployment performs its before-stop and after-stop schema comparisons.
- **Expected:** The failed connection is closed, a fresh full scan succeeds after the lock clears, the candidate is installed and healthy, and the archived held operation remains unexecuted while its exact and prepared receipts show attachment metadata.
- **Replayable offline:** yes, with a disposable WAL database and a controlled lock holder; installed acceptance still requires the normal release and exact owner reads.

- **Seed:** The same transient deployment unit restarts while its nonterminal
  durable run has repair ownership.
- **Action:** The old unit asks to claim the run.
- **Expected:** The claim returns repair ownership, the unit exits successfully,
  and neither a new deployment nor a ten-second restart loop occurs.
- **Replayable offline:** yes, with a disposable deployment ledger.

Evidence: the deployment unit journal at 02:47–02:52 UTC, the run's durable
events, the repair incident, and the installed release manifest.
