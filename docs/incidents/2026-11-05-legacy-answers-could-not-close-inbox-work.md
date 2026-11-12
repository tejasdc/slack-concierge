---
failure: Exact retained historical answers could not close their linked Inbox requests because they predated typed work dispositions.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Legacy answers could not close Inbox work

## What was seen

Inbox request `req:020c5765-fd2d-40ee-83d9-0beae98c8b95` was linked to communication
`df33e3aa-e76b-4ae9-96c6-08c72d035746`. That communication ended answered. Its exact final
is retained and says the deployment hold released, the queued message reached the agent, the
session completed, and no code change was needed. Closing the Inbox request as completed was
still refused as unfinished.

## Cause

The communication completed before final work replies carried a typed work disposition and a
checked or not-checked closing line. The newer Inbox completion guard correctly refused to infer
success from prose, but it had no request-specific path for a router that had verified an exact
historical answer. The retained answer therefore remained attributable but unusable as closure
evidence.

## Fix

Automatic settlement remains limited to typed completed and checked answers. For an older
answered communication without a work disposition, the Inbox router may explicitly close one
linked request and cite the exact final answer event. The owner verifies that the named event is
the unsuperseded final for that dispatch and that its source, responder and answer bytes match the
communication's retained result. The request closure records the router's current completion
judgment; it does not add a disposition to the historical communication.

Unanswered, undetermined, failed or cancelled communications remain open even if a final-looking
event is named. A wrong event, a sibling's answer and an answer not linked to this request are
refused. The router must keep the request open when the historical answer does not itself prove
the required effect, delivery, deployment or live acceptance. Closing never starts another
worker or repeats an acknowledged effect.

## State card

- Entity and writer: one Inbox request, closed only by the Concierge owner after a typed command.
- Identity: Inbox request ID, linked dispatch ID and retained final event ID.
- Acceptance: the retained final proves who answered what; the router's request-specific closure
  says that answer covers the whole obligation.
- Safe default: missing, mismatched or uncertain evidence leaves the request open.
- Historical boundary: the communication result stays immutable and continues to show no work
  disposition.

## Acceptance scenario

- **Seed:** One open human Inbox request linked to a historical work communication whose exact
  final is retained without a work disposition.
- **Action:** Try to close it while the communication is undetermined, then with a different final
  ID, then after restoring its answered outcome with its exact final ID.
- **Expected:** The first two closes are refused. The exact answered final closes only the linked
  request as completed. The communication row and its answer remain unchanged and only one
  dispatch exists.
- **Replayable offline:** yes, against a temporary owner ledger through the release fixture.
