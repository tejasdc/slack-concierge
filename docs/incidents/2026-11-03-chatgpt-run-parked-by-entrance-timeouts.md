---
failure: A ChatGPT Pro question still being answered was reported as failed because Thinkering's front entrance cut every quiet 90-second wait for its answer.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# A live ChatGPT Pro answer parked by entrance timeouts

## What was seen

Turn 19752 in session 8052 (a Pro second opinion, acknowledged at 10:31:47 UTC) was parked at
11:53:52 with "The private capability refused the request (HTTP 503)", and requester 8012 was told it
failed, while Thinkering kept reading the run and ChatGPT was still writing its answer.

## Cause

Thinkering now sits behind an entrance (remote-box `thinkering-entrance.mjs`) that destroys an
upstream request after 90 seconds without bytes and answers 503 `UPSTREAM_TIMEOUT`. Concierge follows
a ChatGPT run with a long observe request that answers only when there is news, so every observation
during a quiet stretch of Pro thinking ended that way: the entrance logged one every two minutes from
11:33:21. Concierge's `readAcrossRestart` retries such 503s for 20 minutes from the first failure, but
never re-armed that window between consecutive long-wait failures, so the tenth, at 11:53:52, exactly
20 minutes after the first, parked the run.

## Fix

A failed read that had been held open for more than a minute proves Thinkering answered the
connection, so it starts a fresh 20-minute window; only quick failures in a row count as an outage.

## Acceptance scenario

- **Seed:** an acknowledged ChatGPT run with no new events for 30 minutes, observed through a proxy
  that ends any request idle for 90 seconds with 503.
- **Action:** let Concierge observe it for 30 minutes, then let the run produce its answer.
- **Expected:** each 503 is followed by a new observation, the turn is never parked, and the answer is
  delivered when it appears.
- **Replayable offline:** yes (a capability socket stub that holds observe for 90 s then answers 503).
