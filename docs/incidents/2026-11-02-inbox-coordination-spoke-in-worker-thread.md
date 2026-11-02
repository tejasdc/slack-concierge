---
failure: Internal request cancellation and the Inbox router's own summary appeared as conversation replies while another agent owned the thread.
date: 2026-11-02
fix_commits: [c9f84036]
cause_status: confirmed
---

# Coordination spoke in the worker's thread

## What was seen

In the canvas thread, a canceled request about the separate thread-protocol work appeared as a full handoff card followed by a Service cancellation message. In the Uber Eats thread, the Inbox router summarized the worker's report, prompting Tejas to ask why it spoke there and how it knew the worker's details.

## Cause

The conversation projection treated a generated cancellation notice as a message. The Inbox router also summarized a worker's report. The earlier instruction against reading a worker's record did not prevent that summary.

## Fix

Keep requester cancellation as request state and remove its generated service post from live and already prepared conversations, while preserving Tejas's own Stop acknowledgment. Keep genuine agent answers and prompt-answer overdue notices. The automatic handoff receipt remains the routing mark. Refuse relaying a service return the agent already posted. Expose both requesting and receiving sessions on a work item for correct attribution. The Inbox's instructions route questions about a worker's job to that worker.

The first repair also blocked the Inbox router's own substantive posts while another agent worked on the topic. Tejas found that it blocked his direct questions to the Inbox, so the worker-open posting check and its shortened fallback reply were removed. An agent's open work no longer limits another agent's ability to post [decision: agents-are-never-handcuffed].

The public work item also identifies a proven canceling actor and a direct human source when
there is one. A canceled internal thread-upkeep handoff is withheld from the public work pane;
the exact request and cancellation remain retained by request ID.

## Acceptance scenario

- **Seed:** An Inbox topic has an open work request to another agent. A separate request in the topic was canceled and generated a Service notice.
- **Action:** Read the conversation and try to make the Inbox router post a substantive summary while the first worker remains active.
- **Expected:** The requester cancellation is visible as work state, not as a conversation message; the Inbox post succeeds and is attributed to the Inbox while the worker remains active. The worker's answer, Tejas's Stop acknowledgment and required overdue notices still appear. A service return already posted by the agent cannot be relayed by the Inbox.
- **Replayable offline:** yes (seed the request and event ledger, then exercise the production projection and post command against scratch state).
