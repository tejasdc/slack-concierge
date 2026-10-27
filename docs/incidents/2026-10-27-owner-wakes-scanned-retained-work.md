---
failure: Concierge repeatedly stalled while background wakes searched retained schedule and input history.
date: 2026-10-27
fix_commits: []
cause_status: best-explanation
---

# Concierge paused during background ledger work

## What was seen

From about 09:30 UTC, the owner accumulated 26.1 and 25.8 seconds of event-loop lag in consecutive ten-minute windows. Several one-second intervals contained more than a thousand ledger calls and over a hundred transactions, with no request in flight. CPU time tracked storage occupation; host I/O pressure was below one percent. The slowest statements appeared in the repeating-schedule clock and communication reconciliation. The outside monitor reopened incident `b670a2d5-daf8-489f-8a55-151fd6f38575`.

## Cause

The installed clock selected the latest firing by scanning every turn and probing for a later firing. A bounded diagnostic snapshot had 12,094 turns, 895 retained repeating firings and only 14 repeating roots. The communication reconciliation scanned retained accepted inputs for unresolved admission on each execution change. That snapshot had 50,492 inputs but no inputs meeting either recovery predicate, and 28 open communication requests among 4,318 retained requests. Query plans showed repeated searches through the broad unresolved-turn index and rowid scans through resolved requests. These are confirmed unbounded reads on routine wakes; their share of every observed lag interval is the current best explanation, not an exact attribution of every small ledger call.

## Fix

The clock now starts at indexed repeating roots and seeks each root's latest firing with the existing unique root/sequence index. The same due, pause, overlap and successor rules remain. Recovery now indexes unresolved Thinkering inputs, unresolved capture inputs and open communication requests before checking receipt details. The snapshot returned the same 14 latest firings and six currently due firings under old and new queries, and the new query plans seek the indexed live sets.

## Acceptance scenario

- **Seed:** Retain at least 12,000 turns with hundreds of historical repeating firings under a small set of schedule roots, plus tens of thousands of resolved inputs and requests with no unresolved admission.
- **Action:** Run the saved-work clock and communication reconciliation on repeated queue and execution wakes.
- **Expected:** The clock selects exactly the latest firing for each root and the same due firings; its plan scans indexed roots, not all turns. Recovery selects no resolved input and seeks the narrow unresolved indexes rather than scanning retained inputs or closed requests. After installation, the live ten-minute owner-lag total returns to its usual few seconds under ordinary traffic.
- **Replayable offline:** yes (selection and query-plan checks on an isolated database; the live lag observation requires the installed owner).
