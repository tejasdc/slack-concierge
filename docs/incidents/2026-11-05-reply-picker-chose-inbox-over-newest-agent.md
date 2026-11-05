---
failure: In an Inbox thread, the reply box and the Control-Space bar opened on the Inbox agent although another agent wrote the thread's newest message and the Inbox agent had not spoken there for hours.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# The reply picker chose the Inbox agent over the agent that had just answered

## What was seen

Nov 5, 3:16 AM ET, web build 3139d76, thread "Anthropic talk on self-improving agents, compared
with our sleep cycles": the newest message was from "Anthropic self-improving agents talk vs our
sleep cycle" (concierge:8674) at 3:10 AM, yet Control-Space opened on "Inbox agent, in this
thread" and the reply bar read "Reply To Inbox agent" (Tejas: "There is not a single message from
the Inbox in this thread in the longest time. Why is that getting selected?"). Fourth report on the
reply picker that night; thnkr.ing failure case
`thinkering-reply-default-ignored-agents-own-posts`.

## Cause

The one reply rule (`bot/src/reply-target-rules.ts`) chose: the agent owning the item replied
under, else the one agent with open work, else the router. Posts were credited to their writer
only when `postedBy='owner-forward'`. The 3:10 message, `post:5db6611d-9692-45b0-aa56-aed3f1fa2abc`,
was a post 8674 made itself (`sessions post --thread`: `postedBy` is its input id,
`postedBySession` names it), so no choice owned it. 8674's request had settled at 07:47:56 UTC, so
nobody was at work and the router won. Confirmed from the thread's entries read through the app
route (author and id of each message) and the rule's source; the shape predates tonight's handoff
repair (`02c53316`), which changed only which sessions appear.

## Fix

One invariant: the default is the writer of the item he is replying under when he named one,
else whoever spoke last in the thread, taken from each post's own writer (every post except
`postedBy='service'`, credited through the handoff chain; a post with no `postedBySession` is the
router's own reply). The single-working-agent fallback applies only where nobody has spoken.
`prepared-topics.ts` recomputes every stored thread once (`newest_speaker_reply`) so existing
threads follow the rule.

## Acceptance scenario

- **Seed:** a thread whose agent A answered by forward and whose request then closed, after which A posted directly into the thread; a second agent B with open work that never posted.
- **Action:** read the thread's reply targets with no item named.
- **Expected:** the default is A (before: the router; with only B at work and A's forward newest, before: B).
- **Replayable offline:** yes (scratch ledger with the owner-event, request, event and handoff tables; rehearsal in the fixing session).
