---
failure: An agent answered a routed Inbox message, but the answer never appeared in its source thread.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# A routed answer was missing from the source thread

## What was seen

Tejas asked what the Cloudflare copy stored. Inbox routed his exact message to an existing agent session. The recipient settled the request with a full answer, and the topic dispatch recorded an answered outcome. The source thread showed a handoff waiting for an answer and no answer message. Inbox later had to request a separate post of the already written answer.

## Cause

The route-message path deliberately suppressed the recipient's thread post and marked the final request event received inside Concierge. The source message and topic root were retained in the route payload, but the request was not given its source thread as an answer destination. A completed request therefore did not imply a delivered conversation answer.

## Fix

Keep the source topic root and exact message as the routed request's answer destination. On settlement, post the recipient's answer beneath that source message using the request event's stable identity, then mark delivery received. Apply the same rule to peer agents and retained older routed request payloads. A final event without its thread post stays undelivered for recovery.

## Acceptance scenario

- **Seed:** A marked Inbox test message routed to an existing agent session, with its route receipt visible in the source topic.
- **Action:** The recipient settles the request with an answer.
- **Expected:** The source topic shows exactly one attributed answer beneath the marked message, the request and route show the answered result, and no separate Inbox summary appears. A reread does not duplicate the answer.
- **Replayable offline:** no (the accepted route, recipient settlement, and conversation projection are verified on the live owner and app).
