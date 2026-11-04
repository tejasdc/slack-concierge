---
failure: Concierge could not prepare an update because its safety gate required mount privileges already removed by the deployment sandbox.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Candidate preparation required a fresh boundary inside an inherited sandbox

## What was seen

Incident `aef2992f-e569-4f09-bc01-2b676237b4d0`, deployment run
`bcd7e1c0-21fe-4550-8d50-9c7d7a7c0d84`, rejected candidate
`8e45c329e2325c36bae3e430c5f1dffee22f4d0a` during candidate preparation.
The retained presentation stderr reports `unshare: unshare failed: Operation not permitted`
at the overlay assertion in `database-safety-fixture.ts:141`.
The detached deployment journal records the restored runtime
`4047127b63038285fa9165c9e120399ec680ad7d` and successful service probes.

## Cause

The installed immutable `release-manager.js` launches the candidate-owned presentation gate
under `privateDatabaseCommand` with `--cap-drop ALL`. The candidate's unchanged builder
does the same. When its database-safety child asks for a mount-capable command, the candidate
helper sees the already inaccessible canonical directory and returns the command unchanged.
The inherited sandbox correctly refuses `unshare --mount`.

The new fixture incorrectly expected fresh-launcher privileges inside that sandbox. Its
subsequent loop-backing lookup also requires the pre-isolation filesystem view. Neither
operation can validate a newly created boundary when that boundary was never created.
The existing packaged-controller checks already require access to the canonical directory
before creating their private mount.

## Fix

Use the same pre-isolation access condition for fresh overlay, locked-mount and backing-image
assertions. Preserve the child ledger-access refusal assertion in inherited isolation, and
explicitly report fresh-boundary coverage as not exercised when the directory is unavailable.
Unexpected access errors still fail the gate. The sandbox and its capabilities are unchanged;
the correction is in the candidate-owned executable gate consumed by the installed builder.

No tests or reviews were run for this repair. Source and retained journal inspection establish
the cause; the commit does not establish candidate acceptance or fresh-launcher correctness.
Integration belongs to the external supervisor; activation and health proof belong to the
normal detached controller.

## Acceptance scenario

- **Seed:** The preceding installed builder and the corrected candidate source, with the canonical ledger hidden and all capabilities dropped for candidate preparation.
- **Action:** Let the normal controller prepare the candidate through its presentation gate.
- **Expected:** The child still cannot read the ledger; the gate reports fresh-boundary coverage as not exercised and does not demand a new overlay inside the inherited sandbox. A separate fresh-boundary invocation retains the overlay, locked-mount and backing-image assertions.
- **Replayable offline:** yes (private canonical state and an inherited sandbox suffice; no production ledger contents are needed).
