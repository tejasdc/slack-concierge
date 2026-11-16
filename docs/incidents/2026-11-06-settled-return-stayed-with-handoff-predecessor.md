---
failure: Final returns for requests the Inbox had sent reached its suspended predecessor after an accepted provider handoff, so two sessions acted on one obligation.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Settled return stayed with the handoff predecessor

## What was seen

Inbox handoff 06b7ff65 (session 8785 to 8876) was accepted at 05:26:59 UTC on
2026-11-06. Returns for requests 8785 had sent (70bbebc1, 94b3d417) were then delivered
to the suspended 8785 (returns 77805063, c9820a4f), which relayed them into their threads
by hand; 8876 reconciled them afterwards. Source: the agent issue report and 8876's
reply to request 7c6363d8. The exact admission time of the two return inputs was not
re-read from the ledger for this record.

## Cause

Handoff inventory and acceptance selected sent requests only while the request outcome
was open. A worker can settle a request before its final return reaches the asker. In
that interval the return is still in the delivery outbox, but the settled request was
outside handoff custody, so its return destination stayed the predecessor. Confirmed
in the source of every release up to this fix; draft PR #639 found the same gap but was
never merged.

## Fix

The inventory lists a settled sent request while its current final return has not
reached the predecessor: not yet written, an unstarted accepted input, or a queued turn.
Acceptance moves the request's return destination to the successor in the same
transaction. An unstarted return input moves in place and keeps its ID; a queued one is
copied with the other safe queued inputs and its return event follows the copy. A
return already handed to a predecessor run is left there (an acknowledged effect is
never replayed) and does not block acceptance, unlike the refusal PR #639 proposed,
which would have blocked every handoff behind one held or uncertain return.

## Acceptance scenario

- **Seed:** A predecessor has three settled sent requests: one whose final return was not yet written to it, one whose return input is accepted but unstarted, and one whose return a predecessor turn already read. A successor handoff is proposed.
- **Action:** The successor accepts with the current digest.
- **Expected:** The first two requests and the unstarted return input belong to the successor; the third stays with the predecessor. The next delivery pass admits both outstanding returns on the successor, and the predecessor receives nothing new.
