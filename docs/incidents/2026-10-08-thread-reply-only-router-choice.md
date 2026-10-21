---
failure: In an Inbox thread, Tejas could only reply to the router, because agents that had already answered vanished from the reply choices.
date: 2026-10-08
fix_commits: [42708335]
cause_status: confirmed
---

# Thread replies could not reach the agent that answered

## What was seen

Tejas, 2026-10-08: "It's the only option. I can't even change to the token allowance session here." Replying
inside a thread offered only the router, even directly under an agent's answer. On a copy of the live record
only 9 of 84 open threads offered any agent.

## Cause

Confirmed from 42708335. `replyTargets` in `session-topics.ts` added an agent as a choice only while it had
work open in the thread (an open request's dispatch still open, a dispatch in flight, an open question). Once
an agent answered and its request closed, it was dropped, so the router became the only option and the default.

## Fix

42708335: every agent sent work from the thread, finished or not, is a choice and owns the answers it returned
or had posted there (returns found through `session_communication_events` and `session_peer_events`
`accepted_input_id`). Replying under an agent's answer defaults to that agent even after its request closed.
Otherwise the default is the one agent still working, else the router. Only open work owns the request's own
messages, so a settled dispatch never catches a reply to something else. After the fix 75 of 84 threads
offered agents (at most 8).

## Acceptance scenario

- **Seed:** a topic whose request was dispatched to agent session S; S replied with a final answer and the
  request closed.
- **Action:** read reply targets for the thread, and for a reply under S's answer.
- **Expected:** S is a choice; the default for the reply under its answer is S; with no item named and no agent
  working, the default is the router.
- **Replayable offline:** yes (scratch ledger)
