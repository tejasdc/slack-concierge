---
failure: The Inbox thread list returned an error before its first Inbox session existed.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Empty Inbox list returned an error instead of its readiness state

## What was seen

An isolated check created an owner with no Inbox session or prepared presentation and
requested the Inbox thread list. The response was HTTP 503. The list contract expects
HTTP 200 with an empty page and incomplete indexing coverage until there is a source
it can authoritatively read.

## Cause

The initial-rebuild fallback always called the ledger thread list. That list requires
an Inbox session, so the pre-session request threw an unavailable error. This is
separate from the prepared-list catch-up behavior after an Inbox exists.

## Fix

The fallback now returns the same explicit unprepared page used when the presentation
database is absent if no Inbox session exists. When an Inbox session exists, it still
reads the ledger during an initial prepared-list rebuild.

## Acceptance scenario

- **Seed:** An isolated owner with no Inbox session or prepared presentation.
- **Action:** Request both Inbox thread list entrances.
- **Expected:** Each returns HTTP 200, no threads, no continuation cursor and incomplete `presentation_indexing` coverage. After an Inbox exists, the initial-rebuild fallback still returns its ledger list.
- **Replayable offline:** yes, with the isolated owner fixture; agent-run tests are currently refused by the installed test policy, so the fixture is retained for an authorized run.
