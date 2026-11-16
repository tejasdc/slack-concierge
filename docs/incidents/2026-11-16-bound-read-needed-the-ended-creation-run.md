---
failure: A test session's creator could not read it from any later run: the bound read needed the creation run to be both still live and exactly the caller.
date: 2026-11-16
fix_commits: []
cause_status: best-explanation
---

# The bound read only worked inside the run that created the test session

## What was seen

After the budget-notice repair, creator 8754's diagnostic for test session 9825 reported zero rejecting inputs, but the bound view with the documented creation pair was refused with AGENT_SOURCE_REQUIRED before any content.

## Cause

Best explanation, from source reading (no runtime probe was made): the Lab content guard requires any agent source header to name a live admitted run, while the bound entrance required that same pair to equal the create request's recorded source pair. The creation run had ended and a new run cannot equal it, so no run could satisfy both.

## Fix

The caller's current live run is the source; the create request is the immutable lineage; they meet by creator session. Authorship, child operations and attachments (with a target proof) follow creator-session membership; controls use one validated create ID; writes need an unfenced session. Lab privacy is unchanged and decided by the current run.

## Acceptance scenario

- **Seed:** a test session created by a run that has ended, with only the creator's own and the test session's own inputs.
- **Action:** a later live run of the creator session reads the view through the bound route with its own pair and the original create request; another session and a human-origin input are then tried.
- **Expected:** the creator's current run is admitted; another session is refused (AGENT_TEST_SCOPE_REFUSED); the human input closes the entrance (AGENT_TEST_SCOPE_CHANGED); an ended pair is refused (AGENT_SOURCE_REQUIRED).
- **Replayable offline:** yes
