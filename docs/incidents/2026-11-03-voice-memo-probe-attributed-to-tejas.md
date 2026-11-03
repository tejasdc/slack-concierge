---
failure: A synthetic Mac Voice Memos delivery probe appeared in the Inbox as Tejas's own recording.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# Voice Memos delivery probe had the wrong author

## What was seen

The Mac watcher sent an explicitly labeled delivery probe through the live Voice Memos
producer door. The source payload carried no agent marker. The Inbox read for capture
`9fd62edcab6b1647a38717c772d1bf967eed94bc393436ba04b52a62a3f39563`
showed its author as "You · Voice Memos" even though the text said it was an agent check.
The Inbox router recognized the probe and took no journal action.

## Cause

The trusted producer door treats an unmarked Voice Memos payload as Tejas's capture.
The Mac test outbox used that same human payload shape for a synthetic probe. The
existing agent marker verifies an input and run in the server ledger, so the Mac
agent's own run cannot supply it over the SSH root-socket path.

## Fix

The established additive author-correction table records this exact capture as an
agent's probe while preserving its accepted bytes and receipt. The Mac watcher owner
was asked to refuse synthetic outbox files unless they come from a real completed
Voice Memos job; it must leave ordinary real-job payloads unmarked.

## Acceptance scenario

- **Seed:** The exact synthetic probe capture above exists in the server ledger with human origin and no agent marker.
- **Action:** Install this release through the normal migration and reload the Inbox read.
- **Expected:** The original capture and receipt remain; the read attributes it to an agent with the correction reason, and it is excluded from counts of Tejas's own words.
- **Replayable offline:** yes (seed that exact accepted input in isolated state and run the owner schema migration).
