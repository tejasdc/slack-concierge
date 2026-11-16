---
failure: Inbox history warm-up restarted from its first row after every yield, so a new prompt could remain waiting.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Inbox prompt could wait for a warm-up that never advanced

## What was seen

After the prompt path was changed to await the yielding Inbox history warm-up, the installed
release became active without an `inbox_entry_index_warmed` completion. Inspection of the
running source found that each warm-up step constructed a fresh empty index and began at row
zero. The earlier 18.5-second synchronous prompt-index scan was real, but this follow-up
release introduced a new wait in the prompt path.

## Cause

The shared index was assigned only to a local variable. Neither the yielding warm-up nor
the synchronous index access stored that object as the process's index state. Its row
watermark was therefore discarded at each yield.

## Fix

Store the index object before either path extends it. Every later warm-up step resumes
from the last processed row. Thread-root invalidation still clears the shared state so
the next step intentionally begins again only when the underlying links change.

## Acceptance scenario

- **Seed:** Start an owner with more Inbox entries than one warm-up batch.
- **Action:** Admit an Inbox prompt while the yielding warm-up is in progress.
- **Expected:** The warm-up watermark advances across yields, logs completion, and the prompt is prepared once with complete thread context; other owner work remains serviceable between steps.
- **Replayable offline:** yes (a fixture with more than one batch can observe progress without provider traffic).
