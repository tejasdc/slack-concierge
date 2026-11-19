---
failure: Concierge held Claude turns when the terminal and a saved agent sign-in used the same account.
date: 2026-11-19
fix_commits: []
cause_status: confirmed
---

# A terminal Claude sign-in blocked the saved agent sign-in

## What was seen

The server reported room on the chosen Claude account, but the runner refused
to start turns because it found more than one matching home. The terminal login
and one saved agent home used the same label.

## Cause

The runner included the terminal login when validating and resolving a named
Claude account. The terminal is a separate sign-in and cannot establish which
saved home should run a turn.

## Fix

Named Claude validation, launch, and transcript lookup consider saved homes only.
Multiple matching saved homes still cause a refusal. Unscoped transcript discovery
continues to search historical locations.

## Acceptance scenario

- **Seed:** Give the terminal and one saved agent home the same Claude label.
- **Action:** Validate and resolve the selected Claude account on the runner.
- **Expected:** The saved home resolves uniquely. A terminal-only label is
  unavailable and two matching saved homes remain ambiguous.
- **Replayable offline:** yes, through the runner account fixture.
