---
failure: The exact Inbox message read reported a corrected agent test capture as human.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Exact Inbox message read ignored an author correction

## What was seen

During the November 6 authorship audit, the exact topic-message command reported the September 23
Thinkering agent test capture `capture:913790e47e8cd27302671d83aafb4744915f9903aed239fcd19233e90f6d19c1`
as `from: human`. The operation receipt said it was not human-authored, and the prepared Inbox
message named the Thinkering agent and its correction. The command is what the Inbox router uses
to read one message's exact words before judging it.

## Cause

The exact read returned the stored origin, or inferred human from a provider user role, instead
of resolving the accepted input's current author. A correction changed the author projection
without rewriting the original human-origin record, by design.

## Fix

The command now returns the current full author and derives `from` from it. An unproved user-role
entry is unknown. The original input and correction stay intact.

## Acceptance scenario

- **Seed:** The retained September 23 capture above, with its existing agent correction.
- **Action:** Read that exact message through `sessions topics message` after installation.
- **Expected:** `from` is agent and `author.session` identifies the Thinkering agent; the words and original correction remain unchanged.
- **Replayable offline:** yes (the exact accepted input and correction are retained).
