---
failure: Concierge posted its internal answer deadline as a Service message in Tejas's Inbox thread.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Internal answer timer appeared in the conversation

## What was seen

At 12:01 PM Eastern on November 4, the thread about sovereignty over the phone showed
a Service message saying no answer had arrived within three minutes. Tejas's bug report
is capture `3fa33b1bbaf0d3113430b3998b3da7ef279653b9c4e7bad3510952a72aaf390b`;
its screenshot shows the message above the eventual agent reply.

## Cause

The October 12 prompt-answer rule reminded an agent after two minutes so a simple
question would not sit behind long work. At three minutes, both the local and Mac
peer request paths also posted an overdue event into the named Inbox thread. The
request ledger and agent reminder were useful; the Service post gave Tejas a deadline
he had not asked for. Other overdue events used the same thread posting path.

## Fix

Timer events remain in the request record and can return to an agent requester when
explicitly requested. They no longer create a thread post. On startup, Concierge
retires earlier timer posts through append-only collapse events, preserving the
original posts and request records as evidence.

## Acceptance scenario

- **Seed:** An agent-marked Inbox thread has an open request awaiting an answer.
- **Action:** Let the prompt-answer reminder and overdue inspection run, then answer.
- **Expected:** The agent receives its reminder; no Service timer message appears in
  the thread or alerts Tejas; the eventual answer appears once in that same thread.
  An older timer message disappears from the thread after installation, while its
  request record remains available.
- **Replayable offline:** no (agent-run tests are disabled by Tejas; use the marked
  live entrance and installed release).
