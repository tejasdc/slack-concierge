---
failure: Canceling one Saved work turn erased other scheduled continuations in the same session.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Saved cancel erased other scheduled continuations

## What was seen

At 2026-11-07 02:11 UTC, the Inbox router canceled one saved turn. Four queued turns in that session, including a Nov 9 continuation for the open Nov 4 refused-reply repair, became canceled. The affected request was `e6947e3a-5d62-4d3d-a39d-0f9b05838b9f`, turn `24767`. Its receipt had no provider acknowledgment and only said `stoppedBy: not-tejas`, so the reader could not distinguish the actual cancellation from a restart or crash. The router later booked replacement live continuations; those were not touched by this repair. Source: agent report `capture:ff506b40a7233e38bf0062d69cbe80cdc1f46f1c359758f1e56e0e18dfe34219` and the Inbox handoff.

## Cause

The Saved work cancellation selected an exact turn but updated all queued turns with the same session ID. It also marked all their accepted inputs canceled, while recording a control event only for the selected turn. Separately, provider handoff treated all saved turns as immovable, so a still unfired scheduled continuation could not move to an accepted successor.

## Fix

The cancellation update requires the selected turn ID and writes the cause and agent source on that turn's accepted input. Request withdrawal and repeat overlap also retain explicit causes. An accepted handoff moves a safe unfired scheduled turn and input to the successor in place, preserving due time and repeat identity while adopting the successor's model and effort. A proposed handoff leaves the predecessor responsible.

## Acceptance scenario

- **Seed:** two future scheduled turns in one role session, one a repeating continuation, with a proposed provider handoff.
- **Action:** cancel the first exact turn, then accept the handoff for the still queued second turn.
- **Expected:** only the first turn is canceled with its cause; the second retains its due time and turn/input IDs under the successor, then books one next repeat firing there. No provider sees it before due time.
- **Replayable offline:** no. The repository blocks new agent-run database fixtures. Use a disposable schedule through the installed marked entrance after review and release; do not alter the replacement live turns.
