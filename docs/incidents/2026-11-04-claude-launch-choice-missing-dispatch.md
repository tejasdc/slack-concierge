---
failure: Agent-started Claude Code account selection failed after the release because its owner route called a dispatch function that was not imported.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Claude account choice failed in the installed owner

## What was seen

The installed release containing the new agent Claude launcher was healthy, but a fresh
launcher request to `GET /sessions/v1/auth/claude-launch-choice` returned
`OWNER_ERROR: chooseClaudeDispatch is not defined`. The launcher refused to start
Claude, as its fail-closed account-selection contract requires. The separate direct
Claude CLI attempt reached its weekly usage limit before a review could begin.

## Cause

The session execution host wired its auth callback to `chooseClaudeDispatch` without
importing that function. Bun bundled the unresolved name and the route threw only
when called live. Import the existing dispatcher at the callback site; retain the
choice and identity checks in the launcher.

## Fix

Import the existing dispatcher at the callback site. The account policy and launcher
identity check remain unchanged.

## Acceptance scenario

- **Seed:** A running owner with the Claude account-choice route and at least one
  account state the owner can evaluate.
- **Action:** Call the installed account-choice route and launch a fresh Claude command
  through the installed wrapper.
- **Expected:** The route returns a valid choice or a named capacity refusal, never an
  undefined-reference error. The launcher confirms Claude's effective account before work.
- **Replayable offline:** yes (a scratch owner can exercise the route with seeded account state).
