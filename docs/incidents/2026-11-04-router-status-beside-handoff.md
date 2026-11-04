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

The marked outside-agent capture `capture:30d252f2bf14414b96b246e50588ab6b85e060b6e9321e9a3c8f2b770a0a3859`
exposed two more cases before final acceptance. Its router turn had already declared `done`
for an earlier queued input, then placed this capture in a test topic, routed it to a second
test topic, and sent request `1fb49e0d-d9a8-424e-8ba4-9d18edb56b03` to a test Codex
recipient. A second `done` for the capture was correctly refused as one outcome already
belonged to the turn, but the agent-thread obligation also refused a route-only `done`
until the router added `post:572b7668` to the test thread. The visible handoff already
answers where this capture went. A routed agent-authored source now satisfies that obligation
when the declared outcome is `done`; genuine answers and questions still require a post.
The closing result filter now looks for routing evidence anywhere in the same turn, because
the result is bound to its opening input while later accepted inputs can supply the routed
source. Source attachments remain tied to each exact routed message.

The live read of that test topic initially labeled its destination topic as a session route:
topic routes retain the Inbox session as their destination session, so that field alone does
not identify the route type. The receipt now gives the topic identity precedence and reports
`thread`; the source message and destination identity stay the same.

The installed multi-destination probe `capture:0b733f61fc523449979a1d00544d623170b9301c2ed359527e87d0111fc42e91`
showed the source route and request `23404259-f098-49d7-bef4-5b76253420a1`, whose exact
accepted instruction was “Acknowledge this marked test only; do not modify files.” The test
recipient's answer appeared as its own post; no router status post appeared. Reading Tejas's
original report afterwards exposed progress-only partials from the delegated implementation
request as separate `post:forward:` conversation messages. Those are request progress, not
answers to him. Progress-only partials now remain on the Work receipt, while prompt answers,
explicitly notified partials, and final answers still post. The prepared-message upgrade removes
older unnotified progress posts from Conversation without deleting their request evidence.

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
