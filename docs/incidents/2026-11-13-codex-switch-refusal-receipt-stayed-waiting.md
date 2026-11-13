---
failure: An explicitly refused Codex account switch remained waiting in supported operation receipts.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# A refused Codex switch looked unresolved

## What was seen

The agent command returned a definitive active-work refusal and the Codex daemon and
account stayed unchanged. The exact operation and receipt-page views nevertheless said
`waiting`, with no result or error. The immediate reply omitted the retained operation
ID, so the experimenter had to associate the response with the operation by timestamp
and source. Earlier explicit refusals had the same receipt mismatch.

## Cause

The switch saved a direct reply with `status`, while the common operation projection
read `state`. It also hid result fields for every action, including this switch. The
retained action already carried the exact ID and agent source; the projection discarded
the useful result.

## Fix

The immediate reply now includes its retained operation ID and normalized outcome while
keeping existing reply fields. The exact operation and compact receipt projections read
the same retained result for this one action type. Historical explicit refusal details
are classified from their saved replies; nothing is replayed or synthetically settled.
Account movement, guards, activation reconciliation and admission holds are unchanged.

## Acceptance scenario

- **Seed:** An exact agent-authored switch operation with a retained failed reply that explicitly says the active-work guard left the runner alone.
- **Action:** Read its exact operation and compact receipt, without issuing another switch.
- **Expected:** Both views report `refused`; the exact result preserves the original reply and the operation identity and source remain unchanged. Applied, failed and uncertain saved results keep their respective outcomes.
- **Replayable offline:** yes; the standalone projection fixture checks retained replies without calling the switch or touching account state.
