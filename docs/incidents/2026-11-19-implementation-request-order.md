---
failure: An implementation request could not wait for earlier work and was retried without the requested ordering.
date: 2026-11-19
fix_commits: [e201c110]
cause_status: confirmed
---

# Implementation rejected an explicit dependency

## What was seen

In the Essos orchestrator transcript on November 19 at 16:17:41 UTC, the request to implement the floating Team control after request `4eb8e83d-1281-409a-9bd2-213ff58805a1` returned the generic implementation argument error. The orchestrator retried without the prerequisite and received request `88b33349-f272-4576-99b5-f8ed47aac333`. The refusal was reproduced using the installed command from the repair session. This establishes lost ordering. The source report also described checkout contention.

## Cause

The command parser and the request owner both excluded dependencies from implementation requests. The ordinary request dispatcher already waits on retained dependencies. The implementation launcher already reserves a Git worktree keyed by the exact source and action so distinct implementation requests have distinct checkouts.

## Fix

Allow implementation requests to use the existing prerequisite and pacing machinery. Keep worktrees assigned per implementation request and reuse the same worktree for an exact retry.

## Acceptance scenario

- **Seed:** A live coding session with work authority and a registered Git project.
- **Action:** Ask for one implementation, then another for the same project using the first request as its prerequisite.
- **Expected:** The second request remains waiting before the first succeeds, then starts in its own checkout. An exact retry returns the same request and checkout. A failed prerequisite prevents dependent work from starting.
- **Replayable offline:** Yes, with a disposable ledger, a real temporary Git project and a substitute provider runner.
