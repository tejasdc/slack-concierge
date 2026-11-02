---
failure: Internal request cancellation and the Inbox router's own summary appeared as conversation replies while another agent owned the thread.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Coordination spoke in the worker's thread

## What was seen

In the canvas thread, a canceled request about the separate thread-protocol work appeared as a full handoff card followed by a Service cancellation message. In the Uber Eats thread, the Inbox router summarized the worker's report, prompting Tejas to ask why it spoke there and how it knew the worker's details.

## Cause

The conversation projection treated a generated cancellation notice as a message. The Inbox router's manual post path also accepted substantive text even while an open request assigned another agent to the topic. The earlier instruction against reading a worker's record did not enforce the communication boundary.

## Fix

Keep requester cancellation as request state and remove its generated service post from live and already prepared conversations, while preserving Tejas's own Stop acknowledgment. Keep genuine agent answers and prompt-answer overdue notices. When local or Mac work is open for another agent on the topic, allow the Inbox router only a short one-line post it already owes that thread; its automatic handoff receipt remains the ordinary routing mark. Refuse relaying a service return the agent already posted. Expose both requesting and receiving sessions on a work item for correct attribution.

## Acceptance scenario

- **Seed:** An Inbox topic has an open work request to another agent. A separate request in the topic was canceled and generated a Service notice.
- **Action:** Read the conversation and try to make the Inbox router post a substantive summary while the first worker remains active.
- **Expected:** The requester cancellation is visible as work state, not as a conversation message; the substantive Inbox post is refused without adding a message, while a short owed routing answer can satisfy the turn. The worker's answer, Tejas's Stop acknowledgment and required overdue notices still appear. A service return already posted by the agent cannot be relayed by the Inbox. After the worker request settles, an Inbox post may proceed normally.
- **Replayable offline:** yes (seed the request and event ledger, then exercise the production projection and post command against scratch state).
