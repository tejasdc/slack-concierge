---
failure: A managed native Codex helper edit was refused after its parent turn completed normally.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
replayable: true
installed_acceptance: pending
---

# Native Codex helper identity expired with its parent turn

## What was seen

The original incident involved helper thread `01a1d15b-33b7-7b33-8838-91936954cddb`,
parent session 9487 / thread `01a1d153-8e21-7302-81f8-9447203f64b8`, and child
provider turn `01a1d6dc-7dfe-7233-96d9-2d487c16de29` reporting `gpt-6.1-sol`.
An edit succeeded at 21:47:12Z. The parent completed at 21:48:40.415Z; the same
child turn's next edit was refused at 21:48:52.323Z. The earlier Nov 12 repair
only covered helper attribution while the parent was running.

Before this repair, a disposable native reproduction reached the same failure:
Luna and Sol child turns were seeded while parent turn `01a1d701-2a3a-7720-9c61-d6b4334ac37f`
was active. The parent completed at 22:23:51.572Z. After the release barrier,
the Sol edit was refused at 22:25:25.144Z and the Luna edit at 22:25:30.685Z.
Their markers remained `seeded`. Exact transcript line references and barrier
readback are in the disposable evidence file
`/root/workspace/slack-concierge/.wt/native-helper-lifetime/tmp/reviews/before-release-native-evidence.json`.
This is a reproduction of the lifecycle defect, not installed acceptance.

## Cause

The edit gate resolved a mismatched Codex child turn only through the parent's
currently running turn. After normal completion, that lookup returned no parent;
the owner had never retained which parent turn first admitted the child. The
previous Nov 12 repair remains valid for its original case: a helper with no
owner-turn hint is attributed to one uniquely running parent.

## Fix

The owner records one immutable event binding the parent session and child
provider turn to the exact uniquely resolved parent turn and reported model.
Later edits resolve by the event's existing unique ID and remain attributed to
that original turn after normal completion. Model conflicts, missing evidence,
Stop, failure/uncertainty, pause/archive, unknown children and ambiguous first
admission remain refused. No transcript ancestry scan is used.

## Acceptance scenario

- **Seed:** A disposable owner ledger has one running Sol parent and native Luna
  and Sol helper turns with distinct child provider-turn IDs.
- **Action:** Edit under each child while the parent runs, record any Sol reason
  before the parent ends, then complete the parent. Retry the Sol fifth edit
  with and without that existing reason. Reopen the ledger in a fresh process
  and make a new Luna edit from the same retained child execution.
- **Expected:** Luna remains separately recorded; Sol stays held at the fifth
  edit until the original-turn reason is present; duplicates preserve receipts;
  a newer parent receives no old-child edits. Stop, error/cancel/uncertain/queued,
  pause/archive, changed or missing model, unknown child and ambiguous parent
  remain refused. Run `bun run bot/scripts/implementation-edit-gate-fixture.ts`
  to replay the owner-ledger cases and indexed identity lookup.
- **Replayable offline:** yes (the owner-ledger fixture); installed acceptance
  still requires a live native helper turn.

## Acceptance boundary

The offline fixture establishes the owner-ledger contract. A live native-helper
check through the installed release is still required before claiming the
original user-visible failure is resolved in production.

A Sol hold after parent completion cannot be released by submitting an old
source/run to `sessions edit-reason`: that command correctly requires a live
parent turn. The retained identity does not change that restriction. A reason
needed by delegated Sol work must already exist before its parent ends.
