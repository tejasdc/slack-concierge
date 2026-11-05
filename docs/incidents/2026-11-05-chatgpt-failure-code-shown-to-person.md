---
failure: Thinkering showed CHATGPT_SEND_FAILED as the explanation beneath failed messages.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# A ChatGPT dispatch code appeared as the failure explanation

## What was seen

Two retained inputs in a production session showed `Failed` followed by
`CHATGPT_SEND_FAILED`. The diagnostic code did not explain whether ChatGPT had received the
message or whether the input would retry.

## Cause

The receipt owner used the retained ChatGPT dispatch code as both its machine-readable code and
its person-readable explanation. After that policy was corrected, the exact receipt route returned
the new sentence but Thinkering still received a historical prepared receipt computed by the prior
release. Prepared receipts refreshed only when ledger facts changed; a release that changed receipt
classification or wording did not invalidate them.

## Fix

The receipt owner translates the two retained not-sent codes into a sentence that says the
attempt stopped before Send, no message reached ChatGPT, and no automatic retry will occur. The
exact code remains available in the raw error detail for diagnosis. The prepared receipt owner now
records the installed projection's derived revision and shadow-rebuilds all historical receipts when
that revision changes. The previous complete generation remains readable until the replacement is
complete, and no accepted input is replayed.

The first refresh implementation incorrectly coupled a receipt-policy change to the full presentation
generation. Its installed activation began duplicating unrelated message and topic projections and
hit SQLite's full-write refusal before it could activate the corrected receipts. The worker now owns
an independent receipt generation and refreshes only the receipt table. Incremental receipt updates,
time-based refreshes and checkpoints all use that receipt generation; message and topic projections
remain untouched.

## Acceptance scenario

- **Seed:** A retained input ends with `CHATGPT_SEND_FAILED` or `CHATGPT_NOT_SENT` before ChatGPT Send.
- **Action:** Read the input receipt and open the session in Thinkering.
- **Expected:** The receipt and failed-message notice explain that the attempt stopped before Send, no message reached ChatGPT, and it will not retry automatically; raw error details retain the exact code.
- **Replayable offline:** yes
