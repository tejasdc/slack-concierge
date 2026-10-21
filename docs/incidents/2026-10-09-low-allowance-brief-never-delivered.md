---
failure: Running agents were never told their Claude account was running low, because every such notice was refused by the database for two days.
date: 2026-10-09
fix_commits: [eeb9c5f9]
cause_status: confirmed
---

# Running agents never received the low-allowance notice

## What was seen

While watching the October 9 live Claude account switch, an agent found the budget brief for running sessions had never
reached a single agent since it was added on October 7. The owner logged "FOREIGN KEY constraint failed" 613 times on
October 9 alone; update-wait notices built the same way had been delivered 26 times since October 8.

## Cause

`briefRunningSessions` in `bot/src/provider-usage-notice.ts` admitted its steered service notice with
`sourceInputId: "budget:<episode>"`. `session_inputs.source_input_id` references `session_inputs(id)`, and the episode
name is not an input, so every admission failed the foreign key and the notice was dropped. Confirmed by the commit's
counts and diff.

## Fix

eeb9c5f9 makes the notice its own source (`sourceInputId: inputId`), the same shape update-wait notices already used, so
the admission satisfies the foreign key.

## Acceptance scenario

- **Seed:** A ledger with one running Claude session on an account whose reading crosses the low-allowance threshold.
- **Action:** The usage watch runs `briefRunningSessions` for that episode.
- **Expected:** One service input is admitted into that exact live run (no foreign-key error in the log), and a second
  pass in the same episode admits nothing new.
- **Replayable offline:** yes (scratch ledger and a synthetic usage reading; no provider needed)
