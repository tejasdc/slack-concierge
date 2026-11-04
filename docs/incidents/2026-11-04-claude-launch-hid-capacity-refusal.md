---
failure: A Claude review launch concealed an allowance hold as an unexplained account-selection error.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Claude review launch hid the capacity refusal

## What was seen

Two explicitly requested Fable 5.1 review commands stopped before Claude started. Both said only that Concierge could not select a Claude account. A later probe reached Claude on an account whose weekly allowance had already been measured at 100%, and Claude refused it.

## Cause

The owner returned an error object with the specific reason, but the agent launcher read only a top-level detail field. A live request returned "Every available Claude account is out of room." The account reading showed the current account's five-hour window full, another account's weekly window full, and the third account needing sign-in. The generic text hid this normal hold. Six minutes after the weekly reading, the chooser treated that full account as unreadable and attempted it, even though its recorded reset remained in the future.

## Fix

The launcher now reads the owner's error message before falling back to its generic text. The chooser no longer uses an old reading as a reason to attempt an account whose known full window has not reset. Claude identity verification remains unchanged.

## Acceptance scenario

- **Seed:** The owner has no launchable Claude account with room. One account's last weekly reading is over six minutes old, says 100%, and records a future reset.
- **Action:** An agent starts a fresh Claude Code command with the explicitly named model.
- **Expected:** The chooser excludes the still-full account; the command stops before Claude starts and reports the owner's allowance reason. When a usable account has room, the same command reaches Claude with that account and model.
- **Replayable offline:** yes (the refusal payload and launcher extraction can be exercised without credentials; successful admission needs an available real account).
