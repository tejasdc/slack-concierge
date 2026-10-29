---
failure: One capture with three goals could be routed into only one extra Inbox thread.
date: 2026-10-28
fix_commits: []
cause_status: confirmed
---

# A capture with three goals could not get a thread for each goal

## What was seen

While filing Tejas's October 28 capture, the Inbox router placed it in one thread and routed it into a second. A second `sessions topics route` for that same capture was refused with “This message was already routed as topic-change:…”. Posting the original capture in a third thread was also refused because it belonged to another thread.

## Cause

The owner treated the source message as having at most one route, even though each topic-route event already had its own action and destination message identity. The live and prepared source-message readers projected only the latest route as a single link. Other reply and question readers also chose the latest route when given the original source ID.

## Fix

The owner now accepts a distinct topic route per destination thread, with a separate rooted destination message and backlink for each. It refuses a duplicate route into the same current thread. Both source readers project every route in order and retain the first route for older clients. When an original source has several routes, reply and question matching no longer selects one by recency; callers address the exact destination message.

## Acceptance scenario

- **Seed:** One marked Inbox test capture in a source thread and two empty destination threads.
- **Action:** Route the same accepted capture into each destination with distinct action IDs, then address separate work to each routed message's thread root.
- **Expected:** Both routes succeed with different destination message IDs; the source shows two destination links; each destination shows the original words and a backlink; replies remain under their named destination. Retrying an action is idempotent, and a new action into an already routed destination is refused.
- **Replayable offline:** yes for the owner and prepared read projections; the installed Thinkering link and answer placement require a live marked entrance.
