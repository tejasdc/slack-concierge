---
failure: After a Claude conversation compacted, its earlier messages vanished from the session window and his request from before the compaction was drawn below newer messages.
date: 2026-10-29
fix_commits: []
cause_status: confirmed
---

# An older request sat at the bottom of a running session's window

## What was seen

thnkr.ing report 60b1809c (Oct 29, 3:05 AM Eastern, routed as request c7824c43): the canvas
window for "Smart notes habit and Blygger brainstorm" (concierge:7479) showed an Inbox request
from 2:11 AM last, under messages written after it. His words: "There's an older message still
polluting the session window here, appearing at the bottom. I thought we had fixed all these issues."

## Cause

The conversation compacted at 06:12:29 UTC, one minute after that request (`request:0673fbd3`)
arrived. The history import lists rows through the Agent SDK's `getSessionMessages`, which, like
Claude Code's own resume, returns only what follows the latest compaction boundary: 174 of the
transcript's rows, the earliest at 06:12:29. The owner's history therefore began at 06:12:39 and
listed no row for the 2:11 request (nor anything before it), while its receipt still existed;
thnkr.ing draws an accepted input the owner has not listed as a card after everything listed.

## Fix

The import child finds each compaction boundary line and runs the same native reader on a
scratch copy of the transcript cut just before that boundary, placing each earlier part before
the current one and de-duplicating by row id. Concierge still does not interpret the transcript
graph itself.

## Acceptance scenario

- **Seed:** a Claude transcript with one human request immediately before a `compact_boundary`
  line and further turns after it (concierge:7479's transcript `886a77ce…` is one).
- **Action:** run the history import child on it.
- **Expected:** the snapshot lists the pre-compaction rows, including that request, before the
  compaction summary, each row once; on concierge:7479, 464 rows instead of 174, with
  `request:0673fbd3` at its own time.
- **Replayable offline:** yes (the import child reads only the transcript file).
