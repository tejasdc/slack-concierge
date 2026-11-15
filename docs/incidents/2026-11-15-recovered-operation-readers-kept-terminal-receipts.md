---
failure: A recovered ChatGPT request was refused while different readers returned different admission histories.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# Recovered operation readers kept terminal receipts

## What was seen

Request `81ae7737-61b7-4a1b-a9bb-8f4542e9660c` reports the original review operation
`request:2ac79b16-f4c4-4d93-9cf8-261b3e0e2404`, run `96029fbb-1133-4dca-8c16-615585d475b7`.
Supported recovery requeued that same run. At 03:48:12 UTC, dispatch attempt six was refused
with `ADMITTED_RUN_MISMATCH`, before provider start or Send. No recovery, cancellation, packet
change or receipt editing was performed by this investigator.

The canonical ledger retained the sixth admission at sequence 1949846; it equals the original
admission. Independent direct reads from the installed reader sockets returned histories
`[1,2,3,4,5]` and `[1,2,3,4,5,6]` for the same operation. The old API view therefore could not
establish that an admission was absent. Input references, prompt hash, all 22 attachment pins
and the retained owner context matched; serialized contexts were identical at 5,238 bytes.

## Cause

Each reader's operation projection reused its own settled-receipt cache. Canonical admission
updates invalidated only the canonical process's cache. Reopening a failed operation did not
invalidate the readers. This stale-reader defect is confirmed; that particular attempt failing
the running-state predicate is the best explanation, because the generic mismatch response did
not identify its branch. No different immutable field was proved.

This is separate from the attachment blocker: ChatGPT currently permits 20 selected files,
while the unchanged review includes 22. thnkr.ing's attachment refusal reporting repair is
tracked by `thinkering-chatgpt-file-selection-never-started` in its own repository.

## Fix

The exact single-operation read builds the receipt from current retained state rather than
the process-local settled cache. Bulk lists keep that cache's original purpose: avoiding a
full reconstruction of thousands of Inbox receipts. No equality check, admission rule,
request identity, stored receipt or once-dispatched boundary is weakened or rewritten.

## Acceptance scenario

- **Seed:** An independently admitted, marked benign ChatGPT operation failed before Send;
  both reader processes have read its terminal receipt.
- **Action:** Recover only that benign operation through the supported owner entrance.
- **Expected:** Both exact reader routes expose its new admission and current execution state;
  native file selection reaches ChatGPT, whose actual rejection is retained without Send.
  The original formal review is not retried by this check.
- **Replayable offline:** no (the requested acceptance uses the installed native channel).

Pre-release evidence: independent live reader disagreement and exact canonical sixth admission;
required source bundling. Installed acceptance remains pending.
