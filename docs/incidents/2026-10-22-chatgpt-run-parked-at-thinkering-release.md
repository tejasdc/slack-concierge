---
failure: A ChatGPT Pro question still being answered was reported as failed because a Thinkering update happened while Concierge had been waiting on it for half an hour.
date: 2026-10-22
fix_commits: []
cause_status: confirmed
---

# A live ChatGPT answer reported as failed at a Thinkering update

## What was seen

At 20:14:43 UTC a Thinkering release started. Six seconds later Concierge parked turn 11214 in
session 3750 (a Pro question acknowledged at 19:40) as uncertain, and its requester was told the
request failed, while Thinkering's next process went on reading that same run in ChatGPT.

## Cause

Concierge follows a ChatGPT run with one long observe request at a time. A release now closes
quiet observe requests so it is not held by them (Thinkering #370), and Concierge asks again
through `readAcrossRestart`, which retries a restarting Thinkering for 20 minutes. That window was
measured from the first ask, not from the first failure. The observe request had been open since
about 19:44 while Pro thought silently, so when the release closed it about 30 minutes later the
window was already spent and the first failure was thrown at once. Found by an independent
read-only review (GPT-6 Sol) and confirmed against the installed bundle.

## Fix

The 20 minutes now count from the first failed read, so a long wait that ends in a release is
retried like any other restart.

## Acceptance scenario

- **Seed:** an acknowledged ChatGPT run whose observe request has been open for more than 20
  minutes with no new events.
- **Action:** Thinkering answers that request with 503 `CHATGPT_CAPABILITY_UNAVAILABLE` (a release
  closing it), then answers the retry from its next process.
- **Expected:** Concierge asks again after a short pause and keeps following the same run and
  cursor to its answer; the turn is not parked.
- **Replayable offline:** yes (a capability socket stub that holds one observe past 20 minutes,
  then answers 503 once).
