---
failure: An agent handoff appeared separately from the Inbox thread where Tejas and the working agent were talking.
date: 2026-11-01
fix_commits: []
cause_status: confirmed
---

# An agent handoff was outside its thread

## What was seen

While discussing Canvas voice mode, Tejas saw the Inbox router explain another agent's work in his thread. He asked for his request, the router's brief and the working agent's answer to share that thread.

## Cause

The request owner retained the correct thread address for answers, overdue notices and final outcomes, but the outbound request message itself was projected as a separate thread root. That left the router's handoff outside the conversation. The router's choice to inspect another agent's working transcript is a separate instruction issue owned by the Inbox router.

## Fix

Project an ordinary named-thread request into the retained thread and display its destination, summary, full brief and exact source words when available. Keep its immutable request identity and deadlines. The Inbox router owns the companion instruction to use the thread and avoid another agent's working transcript.

## Acceptance scenario

- **Seed:** A placed Inbox thread contains a human message and has an available working agent.
- **Action:** The router asks that agent to work with the human message as the named thread.
- **Expected:** The thread shows the router's handoff with the agent destination, summary, brief and the human's exact words; that agent appears among reply targets; its answer and any overdue notice appear in the same thread without a return waking the router; the request still closes exactly once.
- **Replayable offline:** yes (isolated owner and prepared-message state can exercise request admission and projection).
