---
failure: The Accounts page read Tejas's own account choice back to him and described terminal sign-ins, news about nothing that his interface decisions forbid.
date: 2026-10-08
fix_commits: [f02a850a]
cause_status: confirmed
---

# Accounts told him which account he had chosen

## What was seen

Tejas reported at 2:55 AM on 2026-10-08 that the Accounts line read: "New Claude work uses <his choice>, the
account you chose. The sign-in typed in a terminal here (...) is that terminal's own; agents never run on it."
The first half repeated his own choice; the second reported machinery working as intended. Interface decision
D20 says nothing is said about which account work runs on unless work is actually stopped. Codex had the same
kind of line ("This machine runs Codex on …").

## Cause

Confirmed from f02a850a. The account line text in `session-execution-host.ts` was written for every state,
including the normal one where the chosen account is in use, and the at-limit sentences opened with "You
chose". No check stopped new user-facing sentences that break his recorded rules.

## Fix

f02a850a: the line is empty while the chosen account is in use (the row's "in use" tag carries that) and speaks
only when that account is at its limit, signed out, or none is selected; "You chose" openings are removed;
Codex's line follows the same rule. `.his-words.json` declares which Concierge text reaches him (notice
carriers, account lines, hold reasons, update line) and `.githooks/pre-commit` runs Thinkering's checker on it
(pattern rules, then a model review of each new sentence), with the 13 existing violating hold reasons as a
shrink-only baseline.

## Acceptance scenario

- **Seed:** Claude account X selected and in use with room; a terminal login present in the main folder.
- **Action:** open Accounts (read the provider list).
- **Expected:** no account sentence for Claude or Codex; set X at its limit and the line names the limit and
  what happens, without "You chose".
- **Replayable offline:** yes (scratch account homes and usage cache)
