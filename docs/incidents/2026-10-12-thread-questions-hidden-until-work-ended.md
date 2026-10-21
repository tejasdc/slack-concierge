---
failure: A question Tejas wrote in a thread went unanswered until the working agent's long task ended, because his reply waited in the agent's queue.
date: 2026-10-12
fix_commits: [319342b9, d6c90941, a529a9a3]
cause_status: confirmed
---

# His thread questions waited behind long agent work

## What was seen

Questions Tejas typed into an Inbox thread addressed to its working agent got no answer while that agent was busy; the
agent saw them only when its current turn finished, sometimes much later. The fifteen-minute overdue check postponed
itself while the recipient was healthy, so nothing flagged the silence.

## Cause

`forwardReply` (`bot/src/session-communication.ts`) placed the forwarded request in the recipient's queue, and partial
replies only meant progress. Request liveness (`request-liveness.ts`) had no clock specific to a human question.

## Fix

319342b9 delivers the forwarded reply into the recipient's live run (local and Mac peer), adds `--answers-question` on a
partial reply as the explicit answer signal, and a three-minute owner clock: a reminder to the recipient at two minutes,
an overdue thread notice and a router notice at three. Late answers still post. d6c90941 recovers a live peer delivery
that fell back to a queued turn by redispatching the exact accepted input; a529a9a3 redispatches only inputs still without
a turn.

## Acceptance scenario

- **Seed:** An agent in a long-running turn working a thread.
- **Action:** Tejas replies in the thread with a question; the agent does not answer.
- **Expected:** The question enters the live run immediately; at 2 min the agent gets one reminder; at 3 min one overdue
  notice appears in the thread and the router gets one notice. An `--answers-question` partial before 3 min posts and
  stops the clock.
- **Replayable offline:** yes with a stub provider that accepts steering
