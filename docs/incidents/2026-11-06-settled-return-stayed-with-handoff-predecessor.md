---
failure: Final request returns reached a suspended Inbox predecessor after an accepted provider handoff.
date: 2026-11-06
cause_status: confirmed-in-code
fix_commits: []
---

# Settled return stayed with the handoff predecessor

## What was seen

The Inbox report `capture:3b64d59608774dc26f4e1e265be9497596b567ac48561b93568e6128b307feae`
records two return notices reaching session 8785 after its handoff to 8876 was accepted.
The predecessor relayed them manually. A separate queued capture was reported as unsafe
to move. The report does not establish whether each return was admitted before or after
acceptance; an already acknowledged provider input cannot be taken back.

## Cause

The handoff inventory and its transfer selected sent requests only while their request
outcome was open. A worker can close a request before the final return reaches the
requester. In that interval the final return remains in the outbox, but the settled
request was absent from handoff custody. The return delivery code then used its old
requester session ID.

## Fix

The inventory now includes a settled request while its final event is not received.
Acceptance transfers that request's return destination with the other obligations.
If a return already has a safely queued predecessor input, acceptance copies that
input and points its event at the copy. If its exact input cannot safely move,
acceptance refuses until delivery settles. Request and event identities stay the same;
neither an acknowledged effect nor an ambiguous input is replayed.

## Acceptance scenario

- **Seed:** A predecessor has a settled request with an unreceived final return, and a successor has a proposed handoff.
- **Action:** The successor accepts the current handoff inventory.
- **Expected:** The successor owns that return. If its input is safely queued, the input moves once; if admission is uncertain, acceptance refuses. No new return reaches the predecessor.

A focused source build passed. Concierge's agent test guard refused a new Bun test;
no test authorization was added. A real marked accepted handoff must still verify a
pending final return, a movable queued input, and no new predecessor delivery after
the installed release. Source and build evidence alone do not establish that live result.
