---
failure: Every real Inbox thread change made the prepared thread copy throw, so the prepared views stopped advancing.
date: 2026-10-08
fix_commits: [04dcbf5d]
cause_status: confirmed
---

# Prepared thread views stopped updating after any thread change

## What was seen

On 2026-10-08, after prepared Inbox topic reads went live (aaec55f3 through ffb90594, early morning), every
real topic mutation threw inside the projection worker and the shared projection checkpoint stopped advancing.
Whether Tejas noticed stale thread views in the interval before 10:12 EDT is not recorded.

## Cause

Confirmed from 04dcbf5d (PREPARED-TOPICS.md). In `prepared-topics.ts` the topic item's revision digest was
finalized after writing questions and requests but before writing the topic's history items
(`value.detail.topic.history.forEach(writeItem …)` ran after finalization). Any topic with management history,
which every real mutation creates, then failed its digest check and threw. The release gate had only static
reader growth fixtures, which never exercised a canonical mutation flowing into the projection.

## Fix

04dcbf5d: history items are written before the revision is finalized. New
`bot/scripts/topic-projection-fixture.ts`, run by `presentation-release-check.ts`, creates and renames a
canonical topic and requires a separate worker's checkpoint to advance, then makes a mutation while the worker
is stopped and requires it to appear after a real restart and lease recovery, checking nonempty history and
each history item's digest.

## Acceptance scenario

- **Seed:** scratch ledger and presentation database with the projection worker running.
- **Action:** create a topic, rename it (adds management history), stop the worker, mutate the topic, restart
  the worker.
- **Expected:** the checkpoint advances after each step without errors and the prepared topic shows every
  history item with a matching revision digest.
- **Replayable offline:** yes (the fixture itself)
