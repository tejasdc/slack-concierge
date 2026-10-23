---
failure: Resumed Claude work kept the first turn's identity and allowance context instead of receiving the current turn's details.
date: 2026-10-23
fix_commits: []
cause_status: confirmed
---

# Resumed Claude turn kept old context

## What was seen

Concierge supplied changing identity, allowance, banked-work and title text through Claude Code's system-prompt argument on each turn. Claude Code recorded the first rendered prompt and reused that snapshot on resume. All 80 recently changed Claude transcripts inspected for this work contained a prompt-snapshot record. A later turn therefore received the first turn's details until compaction, even though Concierge submitted new ones. The exact effect on historical cache writes is unknown.

## Cause

The turn-specific details were placed in a system-prompt argument whose snapshot is fixed for resumed Claude conversations.

## Fix

Keep standing instructions in the system prompt. Append changing details to the current message after the author's words so each resumed turn receives them. Retain the owner-verified identity header and exact replay attribution.

## Acceptance scenario

- **Seed:** A Claude session that has already completed one turn, with a changed allowance reading or banked-work state for its next turn.
- **Action:** Resume that session through Concierge with a marked agent input.
- **Expected:** The new provider user message contains the current turn's details after the author's text, and the session history attributes the message to the accepted input exactly once.
- **Replayable offline:** no (the recorded system prompt and resumed provider transcript require Claude Code's live session behavior).
