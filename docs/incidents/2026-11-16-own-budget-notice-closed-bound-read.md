---
failure: A test session's own account-budget notice made its creator's bound read refuse as "other authorship", so the creator could never read the session.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# The owner's own budget notice counted as another author

## What was seen

The creator-only diagnostic (2026-11-16-bound-test-read-refusal-had-no-witness) returned complete
coverage and exactly one rejecting input for test session 9825: a service-origin input that was its
own source and request, pinned to a run of 9825 itself, and carried the account budget brief.

## Cause

The bound content guard rejected every input whose origin was not agent. The owner writes the budget
brief (and background-job notices) as service inputs into the running session itself, so any test
session running while its account was low was permanently closed to its creator.

## Fix

The guard's one shared predicate no longer counts a service input that is of kind input, names itself
as source and request, and is pinned to a turn of the same session. This is read from ledger provenance
only, not from the id's spelling or the text. Every other service, human or foreign-agent input still
refuses, current actor/fence and exact creator lineage are unchanged, and it adds no new authorization.

## Acceptance scenario

- **Seed:** a test session holding only its own pinned budget notice.
- **Action:** its creator's current run does the bound read; a human message is then added and the read repeated.
- **Expected:** the first read is not refused for authorship; the second is refused and the diagnostic names the human input.
- **Replayable offline:** yes
