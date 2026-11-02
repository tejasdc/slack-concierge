---
failure: A message routed into another Inbox thread carried its time without a zone, so thnkr.ing showed it five hours late and labelled the next reply "read after" a future time.
date: 2026-11-01
fix_commits: []
cause_status: confirmed
---

# "sent 10:48 PM · read after Nov 2 at 3:23 AM"

## What was seen

At 10:49 PM Eastern on 1 November 2026 Tejas's thread reply read "sent 10:48 PM · read after
Nov 2 at 3:23 AM" (capture 56aa3436, thread "Canvas voice mode won't…"). 3:23 AM had not happened.

## Cause

The thread held a bug report routed in from another thread at 03:23:35 UTC (10:23 PM Eastern).
The routed copy's projection turned the source input's SQLite `created_at` ('2026-11-02 03:23:35',
UTC with no zone) into '2026-11-02T03:23:35' before calling `stamp`, which appends 'Z' only when
the value has no 'T'. The owner served '2026-11-02T03:23:35'; every browser parses a zone-less
date-time as local time, so it became 3:23 AM Eastern, later than his 10:48 PM reply, and the
conversation's "read after" rule fired. Read live from the owner's thread entries: the routed
copies (`topic-change:*`) were the only zone-less times across thread entries, thread lists,
questions, captures, receipts and the sessions list. Not daylight saving: it was the full UTC
offset.

## Fix

`stamp` appends 'Z' to any time that ends without a zone, and the routed copy passes the stored
time to it unchanged. thnkr.ing's one owner-time parser also reads a zone-less owner time as UTC,
which covers routed copies already prepared before this deploy.

## Acceptance scenario

- **Seed:** an Inbox thread with a message routed in from another thread, whose source input's
  `created_at` is a SQLite CURRENT_TIMESTAMP value.
- **Action:** read the thread's entries from the owner.
- **Expected:** the routed copy's `createdAt` ends in 'Z' and equals the source input's UTC time.
- **Replayable offline:** yes (state copy with `CONCIERGE_STATE_DIR`).
