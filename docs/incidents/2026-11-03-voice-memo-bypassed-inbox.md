---
failure: An Apple Voice Memo transcript reached the journal keeper directly instead of the Inbox router.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# Voice memo bypassed the Inbox

## What was seen

Tejas reported that the November 2 voice memo transcript went straight to the journal
keeper even though it contained material for several threads. He wanted the Inbox agent
to divide and route it like any other capture. That memo was already split by the router
later; its transcription must not be resent.

## Cause

The Mac transcription path had no recognized human Voice Memos producer kind at the
server's local Inbox door. Its available external capture helper records a sender as an
outside agent, so it could not preserve Tejas's authorship for this handoff.

## Fix

The existing private Inbox producer door now recognizes the Mac job's `voice-memo`
source and labels it "Voice Memos" while keeping Tejas as the author. Its stable
recording ID uses the owner's existing exact retry receipt, and ordinary human capture
admission starts the Inbox router. The marked agent test entrance exercises the same
door without presenting the agent's words as his.

## Acceptance scenario

- **Seed:** A new Mac Voice Memos transcription has one stable job ID, original recording start, title, and verbatim text containing two distinct topics.
- **Action:** The Mac job sends its exact payload to the root-private Inbox door and retries the same payload once.
- **Expected:** Both sends return the same capture receipt; the Inbox shows one "You · Voice Memos" capture; the Inbox router receives it to divide the topics; changing the transcript under the same job ID conflicts.
- **Replayable offline:** yes (the owner intake and duplicate receipt can run against isolated state; the real Mac-to-server delivery still needs a live check).
