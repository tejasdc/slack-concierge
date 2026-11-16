---
failure: Mac worktree cleanup reported a generic timeout and discarded its partial results when a native probe exhausted the upkeep budget.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Mac retirement lost its partial receipt on timeout

## What was seen

The installed Mac upkeep completed after 30.551 seconds with `worktrees: thirty-second
retirement admission budget exhausted`, omitting the retirement result. Independent
readback had already proven seven prior moves in Trash with their branches retained;
additional moves from this timed-out pass were not attributed without evidence.

## Cause

The between-candidate budget check returned partial results, but a deadline inside
a native subprocess or predicate escaped that path. The caller caught the error
after the function's local partial receipt was lost.

## Fix

Deadline exits return the accumulated result and budget hold at the candidate
boundary. Any uncertain mutation retains path, HEAD, attempt and operation step in
the existing receipt; later retirement holds and records an existing repair notice
until reconciled. Gate release failures remain explicit without erasing results.

## Acceptance scenario

- **Seed:** Two disposable eligible worktrees, with the first move confirmed.
- **Action:** Inject a deadline during the second eligibility read, then separately
  during its Trash command after the move may have occurred.
- **Expected:** The first receipt remains, the gate is released, and an uncertain
  mutation preserves its exact identity and prevents a repeat on the next pass.
- **Replayable offline:** yes; `python3 scripts/mac-disk-maintenance-test.py` uses
  disposable folders and substitutes only native process/Trash effects for this case.
