---
failure: A cheap native Codex helper (GPT-6 Luna) spawned by a Concierge session was refused every write in its own worktree.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Codex helper edits refused by the edit gate

## What was seen

A native GPT-6 Luna helper spawned by Concierge session 9534 was refused every edit with “Concierge cannot identify this Codex execution and model,” although the gate exists only to hold top-model implementation.

## Cause

A Codex helper sends the parent's session ID with its own turn ID and model. The gate found the parent only through the owner turn ID from the hook's environment, which hooks run by the shared Codex App Server do not carry. The parent was never found, so every helper edit was held whatever its model.

## Fix

The reported model decides. A non-thinking model is recorded as a helper edit against the session's single running turn and allowed. A thinking model or no model is counted against that turn like a main-turn edit, so a mismatched turn ID cannot skip the fifth-edit hold. No running turn, or several without an owner turn ID, still holds.

## Acceptance scenario

- **Seed:** A Codex session with one running Sol turn.
- **Action:** Hooks arrive with a different provider turn ID and no owner turn ID: Luna edits past five, then Sol edits.
- **Expected:** Luna edits are always allowed and recorded as helper edits; the fifth Sol edit is held; no running turn, or two running turns, holds.
- **Replayable offline:** yes (the focused owner-ledger fixture); installed behavior needs a live native Luna helper.
