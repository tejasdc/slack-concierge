---
failure: Phone session sends received conflicts before server custody without a retained reason.
date: 2026-10-23
fix_commits: []
cause_status: confirmed
---

# Phone sends had no diagnosable refusal reason

## What was seen

Four session sends from the phone received HTTP 409. Neither Concierge's accepted command
journal nor its session input ledger contains their action IDs. The refusal log did not name
the attempted client, stream, sequence, occupied action or rule that produced the 409.

## Cause

The ingress returned one generic conflict response for both reused actions with changed
bytes and occupied stream positions. It did not retain the conflict evidence. The exact
cause of the four historical refusals remains unknown until device metadata is available;
this record describes the confirmed diagnostic failure.

## Fix

Ingress now classifies those two conflict rules and retains only command identities,
stream position, reason and changed field names. It returns the same safe metadata in
the 409 response. No attempted command is represented as accepted, renumbered or replayed.

## Acceptance scenario

- **Seed:** In an isolated capture database, retain action A at sequence 1.
- **Action:** Submit action B at sequence 1, then resubmit A with a changed body.
- **Expected:** Both receive a classified 409, one for an occupied sequence and one for
  changed action bytes; the original accepted row remains alone, the two conflict rows
  retain no message text, and the responses contain no message text.
- **Replayable offline:** yes
