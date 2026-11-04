---
failure: The Inbox showed a separate router status reply after routing Tejas's message, without one attached handoff showing what was sent.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Routing appeared as two conversations

## What was seen

On the iPhone, the responsive-design thread showed Tejas's report and a later Inbox reply
describing that it had forwarded the report. The source message did not reveal the accepted
request's recipient and instructions as one attached handoff.

The installed prepared thread read for `capture:637852d8fcd192398bbd563b91dc226984d56e336b853fe00578dc1054d9a27f`
at 06:43 UTC contained one route on the source message and a separate `result:20195` at 06:43:50 UTC.
The result carried the `quiet` reason “added to the responsive design agent's open work; it answers his question in the thread”.
This is a `done` router close that the old conversation projection still published.

## Cause

The route-to-session path recorded a destination receipt, while the explicit request path
recorded a handoff card. Direct agent replies used a third retained carrier request that the
conversation intentionally hid to avoid duplicating Tejas's message. A router turn's closing
text could still be projected as a separate message after routing.

## Fix

Keep each dispatch's exact identity and destination on the source message, including direct
forwarding. Suppress a router's second conversation result only when its turn has durable
routing evidence and explicitly declared `done`; require an explicit thread post for a
substantive response. Reconcile previously prepared `done` results.

## Acceptance scenario

- **Seed:** A marked agent test capture in a test topic, sent to an existing agent, a new session,
  a direct working-agent reply, and more than one destination; include a routing-only close and
  a mixed route plus explicit answer.
- **Action:** Open the installed thread and expand the source message's handoff on phone-width and
  laptop-width screens after the owner and Thinkering releases activate.
- **Expected:** Each source shows its own destinations and exact sent instructions; routing-only
  closure adds no Inbox reply; explicit answers and failures remain visible; refresh creates no
  duplicate or lost handoff.
- **Replayable offline:** yes (the source events and request receipts are retained by identity).
