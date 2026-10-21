---
failure: One Codex conversation stopped taking any input because its thread never answered a resume on Concierge's shared App Server connection, and after five tries its later inputs, including returned answers, were refused at once.
date: 2026-10-21
fix_commits: []
cause_status: best-explanation
---

# A lab conversation refused every message and its returned answers went unread

## What was seen

Session concierge:7200 ("NotebookLM access and lab arm", Codex gpt-6-sol) had a turn running
when Concierge restarted at 20:14 UTC. The adopted turn finished at 20:39:17. From 20:39:19 every
input to the session failed with "Codex app-server thread/resume timed out after 30000ms": turn
10857 five times (20:39 to 20:45), then turns 10858, 10859 and 10867 on their first try. Three
of them carried answers returned by the "Dedicated Canvas three-arm Lab facilitator", so Concierge
raised "a result reached this conversation, nobody has read it".

The App Server logged `composing running thread resume response` for each of the eight requests
on Concierge's connection (server ConnectionId 2770) and nothing after. The same connection
resumed session 6381's thread (19.8 MB history) normally at 20:48. Fresh connections resumed
7200's thread in 147-173 ms with its full 1.36 MB history, with Concierge's own parameters. The
client bridge's socket queues were empty.

## Cause

Best explanation: the answer to a full resume of this one thread is lost or delayed somewhere on
the long-lived connection (server enqueue, WebSocket delivery or the bridge); the logs cannot say
which. Not observed: the App Server's internal state for that connection and thread. An
independent read of the Codex 0.162.0 source (GPT-6 Sol) found no lock or silent skip that would
explain it and recommended a fresh connection.

The Concierge defect that turned one stuck thread into refused inputs is confirmed: a resume
timeout was charged to the Codex account's shared retry budget, so after five attempts the budget
was spent and the next inputs were refused without a retry.

The returned answers were not lost: they sit in failed turns the provider never acknowledged,
and the session's next successful turn carries them as preserved context.

## Fix

- A thread whose resume times out on the shared connection runs later turns on its own App Server
  connection until Concierge restarts.
- A resume or open failure spends that conversation's own retry budget instead of the account's.

## Acceptance scenario

- **Seed:** a Codex conversation whose thread/resume on the shared App Server connection never
  answers, while fresh connections answer.
- **Action:** two inputs are sent to it, five minutes apart.
- **Expected:** the first input's retry opens its own connection and runs; other Codex
  conversations keep their full retry budget; any earlier failed inputs (including returns)
  appear in the first successful turn as preserved context.
- **Replayable offline:** no (needs an App Server connection that drops one thread's answers).
