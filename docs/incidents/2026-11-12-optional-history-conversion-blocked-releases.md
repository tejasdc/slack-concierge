---
failure: A failed optional history conversion could repeatedly prevent unrelated Concierge updates.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Optional history maintenance became a release requirement

## What was seen

Independent Sonnet review of local commit 7404b909 returned NO-SHIP. The queued
conversion was invoked as a required stopped-deployment step. Active backup,
maintenance lock contention, changed source or an unproven object could leave the
same pending batch to fail every later release. This was caught before deployment;
no production update or cache was affected by this implementation.

## Cause

The optional operation's exit status entered the ordinary deployment failure and
autonomous repair path. Its queue entry was removed only for success or one stale
generation error. Conversion receipt failures were therefore release failures.

## Fix

Claim one durable attempt before work, preserve exact failure/custody records,
and remove failed work from the automatic queue. The deployment helper records
deferred lock/entrance failures and continues the unrelated release. It never
changes a queue owned by a maintenance lock holder. A separate sealed capability
fence still refuses an incompatible reader or controller while references exist.

## Acceptance scenario

- **Seed:** Prepare and queue a disposable cache; hold its real maintenance flock,
  or make its backup/source/object gate fail.
- **Action:** Invoke the actual deployment helper under Bash error traps, or the
  maintenance attempt with controlled supervisor state.
- **Expected:** The helper reaches the subsequent release step without a repair
  trap, deferred/failure evidence is available, original bytes and pin survive,
  and a completed failed attempt does not retry on every release. An incompatible
  sealed release still refuses activation until full-row materialization.
- **Replayable offline:** yes; `bot/scripts/history-cache-crash-fixture.ts` through
  the private-code entrance. This proves isolated control flow, not a live release.
