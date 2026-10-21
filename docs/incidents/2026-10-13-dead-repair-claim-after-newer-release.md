---
failure: A failed release kept showing as under repair for three days after later releases had succeeded.
date: 2026-10-13
fix_commits: [c2b28f3d]
cause_status: confirmed
---

# A failed release still appeared to be under repair after newer releases succeeded

## What was seen

A deployment failed and its repair incident stayed in a repairing state for three days. Newer releases for the
same target succeeded in that time, yet the failed run still held repair ownership, so readers (including the
outside monitor) saw an update still being repaired.

## Cause

Confirmed from the commit message and diff. Repair incidents were only closed by their own runner or supervisor.
When that runner died without finishing, the incident and run stayed in `repairing`/`reviewing`/`retrying`, and
nothing in `completeDeploymentRun` or the worker's reconciliation compared it with later successful runs of the
same target.

## Fix

c2b28f3d adds `retireSupersededDeploymentRepairs` in `bot/src/deployment-state.ts`. It selects incidents whose
run is `failed` or `ambiguous` with an open repair state, requires a later `succeeded` run for the same target,
and requires both the recorded runner and supervisor process identities to be dead. It then parks the incident
(no repair-agent handoff), appends the original error plus the reason, and records a `repair_superseded` run
event naming the successor. It runs inside `completeDeploymentRun` and on every `reconcileDeploymentWork` pass in
`bot/src/deployment-worker.ts`. A live runner or supervisor is never retired. Documented in
docs/architecture/DEPLOYMENT-REPAIR.md.

## Acceptance scenario

- **Seed:** A failed `concierge` run with repair state `repairing`, an incident not parked, runner and supervisor
  process identities that are dead; then a later `succeeded` run for the same target.
- **Action:** Record the later success (or run a reconciliation pass).
- **Expected:** The incident is parked with the original error preserved and a successor line; the failed run
  gets a `repair_superseded` event naming the successful run; it no longer counts as under repair. With a live
  runner pid, or no later success, nothing changes.
- **Replayable offline:** yes (deployment-state tables with injected process-liveness function)
