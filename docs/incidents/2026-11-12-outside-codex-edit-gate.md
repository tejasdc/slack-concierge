---
failure: An outside Codex session could not save its experiment note and a report quoting the refused tool was also blocked as an edit.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Outside Codex note and report refused by the edit gate

## What was seen

In admitted outside Codex session 9501, the edit hook refused an experiment note with “Concierge cannot identify this Codex execution and model.” Its later `router-actions.sh report` command was also refused when its quoted description named `apply_patch`. The session's account experiment was left untouched.

## Cause

The outside CLI's JSON events did not bind a provider turn ID to Concierge's running turn. The gate therefore interpreted the main turn as an unidentified execution. Separately, the shell classifier searched the entire command string, including quoted report text, for editing words.

## Fix

The outside prompt hook binds its provider turn ID through the exact owner turn and source run before edit calls. The shell classifier examines executable command words; quoted arguments do not count as edit actions. A truly unmatched edit still fails closed. Legacy Astra turns use the accepted input of each prompt to decide whether Tejas chose to continue or an agent supplied a qualifying reason.

## Acceptance scenario

- **Seed:** A separate outside Sol session with an accepted turn and no provider turn binding.
- **Action:** Its prompt starts, then it saves a note and sends a report that quotes `apply_patch`.
- **Expected:** The prompt binds its turn; the note is decided as an edit, the report is not; the fifth actual edit is held. An unidentified turn stays refused.
- **Replayable offline:** yes (the focused owner-ledger fixture and shell classifier); installed provider hook behavior also needs a live separate outside session.
