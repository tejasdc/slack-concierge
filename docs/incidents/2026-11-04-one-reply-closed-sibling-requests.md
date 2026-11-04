---
failure: One agent's final reply to one Inbox thread's request also closed two other threads' requests with that unrelated answer.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Two Inbox threads showed another thread's answer

## What was seen

The Inbox (concierge:3172) sent seven agent issue reports to session concierge:8428, one
request per thread. The first, 72d5ae8d (a browser look holding the shared lock), opened
recipient turn 20759; the other six steered into the same turn. A Concierge restart at
17:05 UTC left that run uncertain and every reply from it was refused. After the turn ended
(20:01:39), a report-back run replied to 72d5ae8d alone. Requests f421e119 (Reader "not
found" responses) and cfcc11a3 (a missing session) were then settled with 72d5ae8d's text,
each carrying `answered_by_request_id: 72d5ae8d…`, and their own replies were refused with
"already has a final disposition". The Reader thread's Inbox request closed as done on the
wrong answer at 20:02:55. The other four steered requests had already replied for themselves.

## Cause

A September 17 rule: when every input a finished recipient turn received was a request from
one requester, an explicit final reply to any of them settled every other unsettled one, with
the same text. It existed because replies could then name only one request. Since then
`sessions reply --also` lets a reply name several requests, and the turn-end check sends a
recipient back for each request it still owes, so the rule no longer filled a gap; it only
fired when a recipient's own replies were blocked (here by the uncertain run) and then
assigned one thread's answer to others. The Inbox sends one request per thread, so sharing
a turn was never evidence of a shared answer.

## Fix

Removed sibling settling. A final reply settles exactly the requests it names. Requests that
shared a turn stay open until their own reply, a cancel, or the existing stranded-request
reminder and stall path.

## Acceptance scenario

- **Seed:** One requester sends request A to an idle recipient session and, while that turn
  runs, request B (a different Inbox thread) steers into it.
- **Action:** The recipient replies final to A only; the turn ends.
- **Expected:** A is answered with its text; B stays open (no `answered_by_request_id`), and a
  later final reply to B settles it with B's own text.
- **Replayable offline:** yes (session communication coordinator with a steering fixture).
