---
failure: An agent handoff appeared separately from the Inbox thread where Tejas and the working agent were talking.
date: 2026-11-01
fix_commits: []
cause_status: confirmed
---

# An agent handoff was outside its thread

## What was seen

While discussing Canvas voice mode, Tejas saw the Inbox router explain another agent's work in his thread. He asked for his request, the router's brief and the working agent's answer to share that thread.
His first live view of the handoff then showed command guidance, session addresses, and a second copy of his own capture in the conversation. He asked to keep agent coordination reachable without filling the conversation.
The same screenshot showed an automatic related-work suggestion labelled only "Earlier, close to this," without saying who found it or why.

## Cause

The request owner retained the correct thread address for answers, overdue notices and final outcomes, but the outbound request message itself was projected as a separate thread root. That left the router's handoff outside the conversation. The first live check also showed that the prepared reader used a separate display rule: it placed the request in the thread but still showed only the old brief. Once that was repaired, the display rule copied the entire agent brief and original human text into the conversation. The router's choice to inspect another agent's working transcript and to copy tool guidance into its brief is a separate instruction issue owned by the Inbox router.

## Fix

Project an ordinary named-thread request into the retained thread and show only its destination and human-facing summary. The original message carries Tejas's words once; the request ledger retains the full agent brief for work detail. The owner and prepared reader use the same display rule, and the prepared reader refreshes existing requests after installation. Keep the request's immutable identity and deadlines. The Inbox router owns the companion instruction to use the thread, avoid another agent's working transcript, and keep tool guidance out of the public summary.

## Acceptance scenario

- **Seed:** A placed Inbox thread contains a human message and has an available working agent.
- **Action:** The router asks that agent to work with the human message as the named thread.
- **Expected:** The thread shows Tejas's words once and one compact handoff with the agent destination and summary. The full brief remains available in the request record; that agent appears among reply targets; its answer and any overdue notice appear in the same thread without a return waking the router; the request still closes exactly once.
- **Replayable offline:** yes (isolated owner and prepared-message state can exercise request admission and projection).
