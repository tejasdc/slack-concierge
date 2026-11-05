---
failure: Banked phone work started in the afternoon and remained saved after its request was canceled.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Phone work crossed its quiet window and cancellation

## What was seen

Seven phone jobs started briefly around 2:22–2:23 p.m. New York time. Their requests were canceled, but their saved turns remained queued until separately canceled. No completed Android artifact was returned. The life-logistics phone execution reset records the exact request and turn IDs; it is historical source context, not a runtime dependency.

## Cause

Generic banking intentionally releases near an allowance reset even outside quiet hours. The phone jobs carried the overnight requirement only in their instructions, so the bank treated them as generic. Request withdrawal's queued-turn revocation excluded every saved turn, and its reconciliation pass had the same exclusion.

## Fix

An explicit quiet-only bank choice is stored with the turn and inherited by every continuation path at creation. Forecast selection and atomic claim both require the configured local quiet window, with admission ending five minutes before its end. Active quiet-only work is asked to stop at that cutoff. Request withdrawal and recovery revoke a queued saved turn through the same input receipt path as ordinary queued work; a withdrawn request cannot create a new continuation.

## Acceptance scenario

- **Seed:** A quiet-only banked phone turn and a generic banked turn have otherwise eligible allowance at 2:22 p.m. New York time.
- **Action:** The owner considers both for a claim.
- **Expected:** The phone turn remains queued; generic banking can proceed. At night the quiet-only turn may claim, and it cannot claim during the last five minutes before 6 a.m. A continuation keeps quiet-only. Canceling the request removes its queued saved turn from Saved work and marks the input canceled.
- **Replayable offline:** yes, through the isolated quiet-only bank fixture.
