---
failure: The usage report counted the same code edit three times when Claude's transcript appeared under three account homes.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# One edit appeared three times in the usage report

## What was seen

The live five-edit reminder check made one Write and four Edit calls in one Opus turn. The newly installed usage report showed fifteen edits for that session.

## Cause

Claude's provider transcript was present under three account homes. The report cache keyed an edit by file path and tool-use ID, so each copy became a separate edit event. The live cache showed fifteen rows, five distinct tool-use IDs, and three paths for that conversation.

## Fix

The report now counts each provider, conversation, and tool-use ID once when aggregating edit events. It retains the file-path cache for incremental scans. A fixture mirrors one edit in a second transcript file and checks that the report counts it once.

## Acceptance scenario

- **Seed:** One Claude conversation has the same edit tool-use ID in two transcript paths.
- **Action:** Read the per-session and total usage breakdown.
- **Expected:** Both report one edit for that ID, split under the actual model and main conversation.
- **Replayable offline:** yes (runner usage-report fixture).
