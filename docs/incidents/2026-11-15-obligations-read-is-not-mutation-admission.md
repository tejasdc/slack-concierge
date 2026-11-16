---
failure: A native custody mutation client could treat a readable superseded session as authorized to change retained evidence.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# Readable history did not prove current mutation authority

## What was seen

The coordinated archive primary candidate-two review (request
cd1eccb2-cca4-4039-b04a-d706b3c32116, event
ffdc16a9-b8d9-470d-93db-13ad8c483bef) found a source-proven admission mismatch.
Request bdb4f070-f17c-43fb-8a96-b7825f27f39a assigned this narrow implementation;
it was not the primary review request. The custody
client used an ordinary obligations read as its live mutation check. No production
retirement by a superseded actor was established.

## Cause

The obligations entrance deliberately validates the current actor without the handoff
mutation fence. A still-running superseded predecessor or withdrawn successor can read
its history, so a returned session identity alone is not mutation authority.

## Fix

A narrow operation on the existing authenticated owner channel returns current actor
identity only after the existing handoff fence passes. Ordinary reads remain available.
There is no new identity service, inventory, role restriction, ledger mutation or stored
grant. The external custody client must consume this decision before each mutation;
that integration and whole-change review belong to the coordinating archive repair.

## Acceptance scenario

- **Seed:** The coordinated whole-change candidate and the archive task's existing mandatory normal Thinkering ship gates, with exact admitted source identity and retained handoff state.
- **Action:** Through the authorized normal delivery and installed acceptance path, establish that the custody client uses the current mutation decision rather than obligations reads. This record does not authorize a new fixture, suite, sandbox or probe.
- **Expected:** Exact active input/run and session identity are admitted; unknown, mismatched, stopped and stale sources refuse. Superseded and withdrawn actors retain the existing mutation refusals, including successor routing, while ordinary reads still work. No inventory accompanies admission.
- **Replayable offline:** no authorized offline fixture in this task. Required review, normal release and installed acceptance remain with the coordinating repair.

## Implementation deviation and correction

The first held implementation added and executed a disposable fixture and introduced a
new test-authorization token plus a ledger-gate allowlist entry. This failed to carry
the originating archive task's explicit prohibition on fixtures, suites, sandboxes and
bypassing disabled test commands into the prerequisite. The reported thirteen disposable
scenario outcomes and negative-control failure remain observed history; they are
unauthorized disposable-only evidence, not authorized acceptance or installed/live proof.

Correction request 89447a87-cfba-4853-915a-00ee49f1a862 removes that owned script from
the candidate, restores both test-gate files to their verified owned base, and removes
the fixture invocation from current documentation. Exact prior source snapshots,
results and hashes remain in the ignored review report, separately labeled historical.
No checks are rerun, no gate is waived, and the runtime actor/fence port remains unchanged
for the same coordinated final whole-change review. No production mutation was performed.
