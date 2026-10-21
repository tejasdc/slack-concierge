---
failure: Switching Claude accounts reported "It answered a real request" even when Claude had refused the test as out of usage, and the account line stayed stale after the switch.
date: 2026-10-10
fix_commits: [6cb75257]
cause_status: confirmed
---

# The account switch result said the account answered when it had refused

## What was seen

At 2:10 AM on October 10 Tejas switched to an account; the app said it answered a real request, but Claude had refused
the test as out of usage. Minutes after his reset the page still said chann.app was at its limit.

## Cause

In `bot/src/session-execution-host.ts` the switch check's outcome only decided whether to proceed; the app printed a
fixed "It answered a real request" sentence for every applied switch. No usage reading was started after the switch, so
the page showed the last (pre-reset) reading.

## Fix

6cb75257 returns a sentence that states what the test showed ("Switched to X, but it did not answer the test request:
Claude said it is at its usage limit…" vs "Switched. X answered a real request on this machine.") and schedules a fresh
usage reading on every switch.

## Acceptance scenario

- **Seed:** Two Claude homes; the probe stub for the target account returns a usage-limit refusal.
- **Action:** Switch to the target account through the Accounts route.
- **Expected:** The response detail says it did not answer and why; a usage refresh is triggered; with a successful
  probe stub the detail says it answered.
- **Replayable offline:** yes (stub probe)
