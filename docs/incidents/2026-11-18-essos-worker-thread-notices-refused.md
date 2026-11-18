---
failure: Concierge refused direct notices from the agent working on the Essos Inbox thread.
date: 2026-11-18
fix_commits: []
cause_status: confirmed
---

# Essos thread notices were refused

## What was seen

The Essos orchestrator posted during a ChatGPT return and got a refusal about a
missing open Inbox request. Retrying with its own open dispatch ID got the same
refusal. The orchestrator sent the content as a partial reply afterwards.
Both refused attempts left the original open work intact.

## Cause

The future-answer guard looked at the exact posting input, which was a service
return rather than the dispatch the session held. The explicit reference was a
communication dispatch UUID, but the guard only compared it with the Inbox
request’s separate ID. The live topic had that dispatch linked to its open work.

## Fix

Use the retained open work and its delegation chain when resolving a promise in
the destination topic. Recognize a linked dispatch as an explicit reference.
Keep the exact post author, destination, and requested notification in the existing
owner transaction.

## Acceptance scenario

- **Seed:** An open Inbox request submitted to a parent session. Have the parent
  start a worker without copying the Inbox request into a new topic.
- **Action:** Post from the parent with its dispatch ID and from its worker
  without an ID. Include words that promise a later reply. Retry the worker post.
- **Expected:** Both posts appear in the original test thread with one notice per
  author and retain their open work. The retry produces no duplicate. A session
  with no link to that dispatch cannot cite it as its promise.
- **Replayable offline:** yes (`bun bot/scripts/inbox-requested-notification-fixture.ts`)
