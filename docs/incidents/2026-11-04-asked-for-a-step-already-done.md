---
failure: An agent's question asked Tejas to do a step he had already marked done on his to-do list.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Asked to make a Spotify invite he had already made

## What was seen

At 2:58 PM ET on Nov 4 the Diwali agent (concierge:7992) asked him, as a decision with a phone
alert, to make a Spotify collaborator invite. His to-do "Share a working Spotify collaborator invite
for the Diwali playlist with Avi" (created from the thread's first capture) was marked done at
10:20 PM the night before. He replied at 3:25 PM: "I already marked that ... task has done, right?
So why is that like not coming back to you?" The Inbox router had dispatched the work at 2:40 PM
without reading the to-do either.

## Cause

Nothing linked a question to the to-do it asked for. The to-do's done state lived in thnkr.ing and
no agent or owner path consulted it, and matching a question to a to-do by wording is not reliable.

## Fix

A step-asking question names its to-do (`--todo <id>` or `--todo none`). The routed request API
reads that to-do from thnkr.ing before accepting the question and refuses one whose to-do is done
or dropped; an accepted question records the to-do and closes when he ticks it off. The Inbox
router separately reads a to-do's state before dispatching follow-up work on it.

## Acceptance scenario

- **Seed:** a test to-do marked done, and a worker with a thread request.
- **Action:** the worker declares `needs_decision --only-he-can device --todo <that id>`.
- **Expected:** the reply is refused with "He already did this"; no decision question and no alert
  exist. With an open to-do the question files; ticking the to-do off settles it as answered
  within one reading cycle and the worker receives a notice.
- **Replayable offline:** no (needs thnkr.ing's to-do capability socket)
