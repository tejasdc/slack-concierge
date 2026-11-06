---
failure: An exact unsuperseded final could not serve as shared Inbox completion evidence when its recipient answered from a later return input.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Return-sourced final refused as Inbox evidence

## What was seen

Migrated Inbox request `req:094bff89-b628-4dc4-9380-47578ea924da` linked dispatch
`eaf1aacc-d5c7-4c4b-9712-622d051a7e04`, which settled answered with retained,
unsuperseded final `cb983ae5-3229-4444-ac5b-5750e1a98bd7`. A request-specific
completed close citing that final refused `REQUEST_SHARED_COMPLETION_EVIDENCE_REQUIRED`.
The final's source was `return:a421980c-bdb3-4992-b00f-3e14819d65a8`, a later input
to the same recipient session. The Inbox request subsequently closed using the already
forwarded answer post; that closure and the original communication remain untouched.

## Cause

The evidence verifier required the final's source input to equal the dispatch's delivery
input. Concierge permits a recipient session to settle an earlier request from a later
accepted input. The final event's own request ID already binds it to the dispatch, while
its source identifies the turn that actually answered. Requiring those two inputs to be
identical rejected a valid retained final.

## Fix

The verifier now requires a retained source input and run, the exact unsuperseded final
event for the linked dispatch, an answered outcome, and matching responder, answer bytes
and disposition between the event and request result. The Inbox agent still judges whether
that answer covers each shared human request. Missing or wrong evidence remains refused.

## Acceptance scenario

- **Seed:** A final bound to one answered dispatch but sourced from a retained later return
  input, then linked to several Inbox requests.
- **Action:** Cite a wrong final and then the exact retained final for a shared request.
- **Expected:** The wrong final is refused; the exact final closes the request without another
  answer post. The already closed live failover request remains completed after installation;
  no failover action is replayed.
- **Replayable offline:** yes, through the focused legacy completion fixture.
