---
failure: A ChatGPT Pro send that failed once and went through on Concierge's own retry still woke the repair agent.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# A self-recovered ChatGPT send raised a repair notice

## What was seen

At 23:12:48 UTC a Pro send for concierge:7487 failed while choosing Pro (Thinkering's
CHATGPT_BROWSER_TIMEOUT, surfaced as CHATGPT_SEND_FAILED). Concierge queued its own retry, which
ChatGPT acknowledged about 40 seconds later, but the failure had already raised a repair notice and
woken the repair agent (request a35cbac0).

## Cause

The repair notice was recorded for every ChatGPT failure not on a short list of wait codes, before
Concierge decided whether to retry. CHATGPT_SEND_FAILED that is not uncertain is retryable, so the
notice described a fault Concierge was already recovering from.

## Fix

A retryable failure on a turn's first dispatch attempt raises no repair notice; the same turn
failing again on its retry does (still at most one notice per code per hour). The Thinkering side
(the ignored picker click) is fixed there.

## Acceptance scenario

- **Seed:** a ChatGPT turn whose first send fails before Send with CHATGPT_SEND_FAILED.
- **Action:** let Concierge retry; once it succeeds, once it fails again.
- **Expected:** no repair notice when the retry succeeds; one notice when the retry also fails.
- **Replayable offline:** yes (a capability stub failing the first send).
