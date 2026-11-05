---
failure: After an agent handed its conversation to a successor, the thread's reply box and the ⌃Space bar no longer offered the agent whose answer he had just read, and named a successor he had never seen.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# The agent that answered him was missing from the reply choices

## What was seen

In the Inbox thread "A server that stays responsive while agents work", Tejas replied to the
agent "Why the server slowed today and a design that keeps it fast" (concierge:8586), which had
answered him there. The ⌃Space bar offered no choice for it, and the reply box said it would send
to "Slowness thread coordinator", a name he did not recognise (Inbox input
`da95ab5c-ae85-4c33-aba3-9172e32217b9`: "Why was my session that I was actually talking to and
responded before is not in those options here?").

## Cause

At 05:52 UTC concierge:8586 handed its conversation to concierge:8683, whose handoff named it
"Slowness thread coordinator (continued)". A handoff suspends the predecessor, and the one reply
rule (`bot/src/reply-target-rules.ts`) left out every session its caller could not send to, so
8586 and the answers it owned disappeared from the choices. 8683 appeared only because the router
had just sent it work, under its own new name. Confirmed from the owner's reply-choice read of the
thread, which listed 8683 under that name and no 8586, and 8586's session view (suspended,
superseded by 8683).

## Fix

The reply rule follows accepted handoffs to the session still running the conversation, so a
handoff chain is one choice that owns the predecessor's answers, sends to the successor, and keeps
the predecessor's name when the predecessor answered in the thread.

## Acceptance scenario

- **Seed:** a thread whose closed request was answered by session A, then A handed off to B
  (accepted, A suspended), and an open request dispatched to B.
- **Action:** read the thread's reply choices, replying under A's answer.
- **Expected:** one choice, sending to B, named with A's title, owning A's answer and default for
  that reply; no choice is missing.
- **Replayable offline:** yes (a scratch ledger with those rows through `topicReplyTargets`).
