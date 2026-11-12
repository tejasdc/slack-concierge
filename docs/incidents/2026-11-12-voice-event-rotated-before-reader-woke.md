---
failure: A natural voice event disappeared from the Mac observer file before its sleeping investigator could read it.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Voice evidence rotated before the watch reader woke

## What was seen

The Mac file watch saw a voice event on November 9, but its investigator resumed on
November 12. The private observer file then held only four later events, so the
November 9 mode, process identity and resource samples could no longer be read.
The watch's size-change receipt proved a write happened but did not contain the event.

## Cause

The observer retained only the latest four events. The event file is the evidence
source for a watch that can outlive several recordings, so a count limit made the
watch receipt unreadable after four newer finishes. Concurrent finishes could also
race through the same read-modify-write file and temporary path.

## Fix

Keep completed event metadata for fourteen days in the existing private file and
serialize its writes. Report persistence errors in the observer status, and count
pending writes as active work so the normal Mac updater does not restart the listener
mid-write. The file still contains no audio or words. This cannot restore the
November 9 event that already rotated out.

## Acceptance scenario

- **Seed:** More than four completed natural speech events occur within fourteen days.
- **Action:** A file-watch reader wakes after the later events and reads the observer file.
- **Expected:** All of those events are still present with their mode, page attribution
  and bounded samples; overlapping completions do not lose an event. The listener
  status reports a persistence error if the file cannot be written.
- **Replayable offline:** yes (using a disposable observer state directory).
