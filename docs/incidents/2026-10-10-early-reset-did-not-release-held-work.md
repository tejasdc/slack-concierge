---
failure: After Tejas reset an account's allowance early, the Mac kept every Claude request held until the old reset time a day later.
date: 2026-10-10
fix_commits: [7c7e123a, 5d5b7ac0, e3811a8e, 5575232a, 7231ede1, c75c76dd]
cause_status: confirmed
---

# An early allowance reset did not release held work

## What was seen

On October 10 Tejas reset the chann.app Claude allowance at 2:05 AM, but the Mac held all Claude work until Oct 11 for a
refusal that reset had already ended. The usage page agreed the account had room; nothing moved.

## Cause

A recorded usage refusal was cleared only by a successful run on that account, and no run was dispatched while the
refusal stood. A manual reset may emit no event to Concierge, and percentage readings can disagree with real admission,
so there was no path from "the allowance is back" to "release the hold".

## Fix

- 7c7e123a: each reading forgets an account's refusals when every window has room and some window fell since the refusal
  (usage only falls on a reset); peer-read accounts count in availability.
- 5d5b7ac0: Accounts Refresh releases usage-held work for one provider attempt; a Codex reset on the active account wakes
  its holds.
- e3811a8e replaces that broad release with one tool-free check per machine against the held account and model; only a
  provider answer releases matching holds. 5575232a covers preflight holds and cancels a check after one minute.
- 7231ede1 and c75c76dd give turns released by a successful check one-use proof for that account, so a stale 100%
  reading does not re-hold them.

## Acceptance scenario

- **Seed:** A Claude account with a recorded refusal (reset tomorrow) and three held inputs; a new reading shows every
  window lower than at refusal time.
- **Action:** The reading is stored (and separately: Tejas presses Refresh, stub provider answers).
- **Expected:** The refusal is cleared and the three inputs dispatch on that account without being re-held.
- **Replayable offline:** yes (synthetic readings, stub provider)
