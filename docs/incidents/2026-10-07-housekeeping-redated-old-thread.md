---
failure: Router housekeeping on an old thread made it look new, putting a September 22 conversation at the top of his open threads dated that afternoon.
date: 2026-10-07
fix_commits: [42d2f017]
cause_status: confirmed
---

# An old thread jumped to the top of Open after the router tidied it

## What was seen

Tejas, 2026-10-07: "the accent button recording thread … if I go inside, it is still like September 22nd, but the
time on it is like 417 and it's still like it is on my open threads here … we need to separate what is happening
within the thread and what actions you take on the thread." The "Action Button recording" thread, last spoken in on
September 22, showed 4:17 PM and sat at the top of Open.

## Cause

Confirmed from the commit. A topic summary's `lastEntryAt`, `lastEntrySequence` and `unread`
(`bot/src/session-topics.ts`) counted every topic event, including management events: placing, settling or
withdrawing questions, summaries, closing and request bookkeeping. Withdrawing 39 stale questions at 20:17 UTC
therefore stamped the thread with that time, marked it unread and moved it up the list.

## Fix

42d2f017: the summary's time, newest entry and unread come only from conversation entries under the thread's roots
(his messages, the router's posts, agents' returns); the read index no longer gathers management events, which stay
in the Timeline. A separate `closedAt` orders the Closed list. Rehearsed on a copy of the live state: the thread read
2026-09-22T07:43 again and sat last among quiet open threads.

## Acceptance scenario

- **Seed:** an open topic whose last conversation entry is weeks old, with several open questions.
- **Action:** withdraw or settle those questions and add a summary (router housekeeping only).
- **Expected:** the topic's time, unread mark and list position are unchanged; the housekeeping appears in its
  Timeline; closing it sets `closedAt` without changing its conversation time.
- **Replayable offline:** yes (scratch ledger)
