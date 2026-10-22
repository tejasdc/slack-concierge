---
failure: A reply he sent to a working Claude agent, ending in a space, was taken and answered within seconds but stayed below the answer marked Queued.
date: 2026-10-22
fix_commits: []
cause_status: confirmed
---

# His reply sat "Queued" for ten minutes under the agent's answer to it

## What was seen

Bug report `5ab5e722` (thnkr.ing web, 6:07 PM ET). In "Canvas voice assistant bug fixes"
(concierge:7325) he wrote "i can stop the voice session let me know " at 5:57 PM while the agent
was working and holding its run open for a background release retry. The page showed his message
below the agent's 5:57 PM line "Waiting on the next retry after you stop voice mode.", labelled
Queued, with Working 23 minutes underneath. He asked why it had been queued for ten minutes.

## Cause

Delivery was immediate. The run record shows the steering write at 21:57:04 UTC, Claude's
transcript records taking it at 21:57:08 (a `queued_command` row, mid-tool), the owner receipt
has `acknowledgedAt` 21:57:08, and the agent answered at 21:57:14. The background-job wait was
not involved: a follow-up written into a run waiting on jobs is taken the same way.

What failed was showing it. Concierge sent the bytes with his trailing space and kept them as the
steering replay text. Claude stores and echoes a message with trailing whitespace removed. Two
places prove a user message's author by exact byte equality with what was sent:

- the live stream publishes a user echo only when its text is one the run wrote, so the echo was
  dropped (acknowledgement still matched, by the submitted uuid);
- the history projection's retained-steering join compares the transcript text with the replay
  text, found no input, and dropped the row as unattributable CLI text.

So his message never appeared in the conversation, and thnkr.ing shows any message with a receipt
but no history row as Queued, appended after the newest message.

## Fix

The input envelope sends the message in Claude's normal form (trailing whitespace removed), so the
sent and recorded bytes are identical for the live echo, the transcript pickup and history. The
history fallback joins also accept replay text that differs only by trailing whitespace, so
messages already sent with a trailing space regain their author.

## Acceptance scenario

- **Seed:** a Claude session with a running turn (working on a tool or holding for a background job).
- **Action:** send it a follow-up whose text ends with a space.
- **Expected:** the message appears in the conversation as his, placed where Claude read it, with no
  Queued label once Claude has taken it.
- **Replayable offline:** no (needs a live Claude Code process to apply its trimming).
