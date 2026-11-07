---
failure: An outside agent could not withdraw its queued request after the recipient's provider ran out of room.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Outside agent could not withdraw a queued request

## What was seen

The outside incident coordinator's request `6bbcd38c-24e1-4f47-8476-44c0efd2f3e7`
to a Claude session stayed queued without provider acknowledgment. It needed to
withdraw that attempt before an Inbox agent could route the underlying human work
to a Codex successor. The outside command supported ask and get, but no withdrawal.

## Cause

The root-private outside agent API exposed request creation and reading but had no
counterpart to a Concierge session's source-bound cancellation. The ordinary
session cancellation command could not identify the outside agent as its requester.

## Fix

The outside command now accepts the exact request ID, original ask action ID and a
stable withdrawal action ID. The owner checks those identities and revokes only a
turn that has not begun provider admission. It settles the outside attempt as
canceled in the same transaction. A started or uncertain turn is refused, and the
underlying human obligation is untouched. Repeating the original ask or withdrawal
returns the retained result without dispatching a second attempt.

## Acceptance scenario

- **Seed:** One outside request with a queued recipient turn, no owner claim or provider admission, and an unrelated human request still open.
- **Action:** The original outside requester withdraws its exact request using the ask and withdrawal action IDs, then repeats both commands.
- **Expected:** The recipient turn and outside request read canceled; repeated calls create no turn or reply, and the human request remains open. A second request whose recipient turn has started refuses withdrawal and remains open.
- **Replayable offline:** yes, in an isolated ledger under an authorized agent-test scope.
