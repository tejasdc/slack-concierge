---
failure: Twelve replies Tejas typed inside three Inbox threads each became a thread of their own, titled with his first words ("No, no, no, no."), because a router handoff moved the requests carrying them and the thread lookup then lost their thread.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Forwarded thread replies became threads of their own

## What was seen

On 2026-11-16 Tejas found threads titled "No, no, no, no.", "Okay, that's great." and "And
obviously get inputs." at the top of his Threads list. Each held only one reply he had typed on
2026-11-05 between 04:30 and 05:31 UTC inside "A server that stays responsive while agents work"
(7), "Your own Kindle reader built from KOReader" (4) or "Your phone keeps restarting" (1). The
threads were marked recovered and dated at the reply's own time. The Inbox router merged all 12
back by hand on 2026-11-16 around 06:25 UTC.

## Cause

1. Each reply went, correctly, to the agent working on the thread, as a request. The request
   records the thread it was sent for, and the Inbox transcript records the send.
2. On 2026-11-05 the Inbox router handed off from concierge:3172 to a successor. A handoff moves
   custody of every still-open request the predecessor sent: the request's source session becomes
   the successor (`session-handoff.ts`, sent items). The replies' requests were still open.
3. The thread lookup for a sent request asked for it under the session whose transcript held the
   send (`source_session_id = row.session_id`). After the handoff that found nothing, and the
   lookup fell back to treating the request itself as the start of a conversation. Returns and
   worker questions for those requests used the same session-scoped lookup.
4. The same morning (11:33 UTC) the one-time Inbox conversion re-ran because a new Inbox session
   existed (docs/incidents/2026-11-05-inbox-migration-reran-for-new-inbox-session.md). It gives
   every conversation start without a thread its own recovered thread, titled with its first
   sentence and dated at the message's time; these 12 were among its 948.
5. The 2026-11-05 bookkeeping repair retired service notices only, deliberately keeping
   agent-carried items, so these stayed until new activity surfaced them on 2026-11-16.

Evidence: the bounded report window for 2026-11-05 05:19 shows his reply `bb347532…` in
concierge:3172 and its request `9a9957b8…` naming thread root
`capture:6b295f53…`; the topic it was later merged into holds that root; the only code that marks
threads recovered and dates them at the input's time is the conversion. The replay below fails on
the pre-fix lookup with exactly the observed root (`request:<id>`). The production rows of the
conversion events were not read: the owner ledger is hidden from agent runners.

## Fix

A request's thread is fixed when it is sent; which Inbox session currently holds its custody does
not change it. Every thread lookup for a sent request now finds it by its exact id among the
Inbox's sessions (`inboxSentRequest`): the request's own thread root, its returns' thread and a
worker question's thread. A one-time startup repair (`rejoinThreadsSplitAtHandoff`) merges every
recovered thread whose roots were all sent from one other thread back into it, keeping that
thread's name; anything less clear-cut is logged with its topic ids and left alone. A title filter
was rejected: the title was a symptom, the lost lookup was the cause.

## Acceptance scenario

- **Seed:** An Inbox thread, his reply in it carried to a worker as a request, and a recovered thread made from that request.
- **Action:** The router hands off to a new Inbox session, moving the open request's custody; the startup repair runs twice.
- **Expected:** The request and its returns still resolve to the original thread from both Inbox sessions; the recovered thread is merged into it once, without adding his reply's first words as a name.
- **Replayable offline:** yes (`bot/scripts/thread-survives-router-handoff-fixture.ts`).
