---
failure: Tejas's Threads list showed no threads for most of an hour while its prepared copy was being rebuilt.
date: 2026-10-08
fix_commits: [3a0cdc8a]
cause_status: confirmed
---

# The Threads list was empty while it was being rebuilt

## What was seen

On the evening of 2026-10-08, after the newest-first ordering change (3aecf83e) was installed, Tejas's Threads
list in thnkr.ing showed no threads for most of an hour.

## Cause

Confirmed from 3a0cdc8a. 3aecf83e changed the prepared topic projection's schema (`own_items_only`), which forces
a full rebuild of the prepared thread list. A full presentation rebuild is paced and takes most of an hour.
Until the prepared copy was marked ready, both list routes (`preparedTopics` in `session-owner.ts` and the
router helper's `list` in `session-topics.ts`) answered an empty page marked indexing, and the app renders that
as no threads.

## Fix

3a0cdc8a: `preparedTopicsReady()` in `presentation-topic-reader.ts` reads `presentation_topics_meta.ready`.
While it is false, both list routes answer from the ledger through `directTopicList` (the same `listTopics`
rules, about 175 ms warm, coverage `complete:true, source:'ledger'`); once ready, the prepared list answers as
before.

## Acceptance scenario

- **Seed:** a ledger with open threads and a presentation database whose topic projection is rebuilding
  (`ready=0`).
- **Action:** request the open thread list through the owner route and the router `list` command.
- **Expected:** the full first page of threads in the normal order, coverage source `ledger`; after the rebuild
  sets `ready=1`, the same request is served from the prepared copy with the same rows.
- **Replayable offline:** yes (scratch ledger and presentation database)
