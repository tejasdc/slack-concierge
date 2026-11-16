---
failure: A worktree rebase restored another writer's saved changes and conflicted with its own work.
date: 2026-11-07
fix_commits: []
cause_status: best-explanation
---

# A rebase applied the wrong saved work

## What was seen

In capture `922b231f9c6f9b1b42981e4693a89dc26b85c31d0dd7d3de484e846303a86993`,
the agent working in the retirement-guard worktree reported that a plain Git stash
pop after a successful rebase produced conflicts in four unrelated Messages and
instructions files. Its own saved object remained in the shared stash stack.
The agent preserved those conflict files under
`/tmp/concierge-retirement-stash-collision-9284`, restored its own work from
the exact object ID, then committed and pushed the intended six files. The
conflict files were not committed or lost in that worktree.

## Cause

The agent ran stash push, rebase, and bare stash pop manually. Git worktrees
share the repository's stash stack, and a bare pop selects its current top.
The agent did not record its object's ID before popping. Another writer's stash
operation between push and pop is the best explanation for the mismatch; that
exact interleaving was not observed. The absence of an ID-bound rebase command
left this cross-worktree mistake possible.

## Fix

The supported Concierge rebase command creates a stash object without using the
shared stack, pins it in the current worktree's private Git reference, and
restores only that object. A stopped rebase keeps the saved object reachable.
A conflicted or interrupted restore also keeps it reachable and marks the
attempt, refusing a second application until the partial result is resolved
and finished explicitly with the same object ID.

## Acceptance scenario

- **Seed:** Two linked Concierge worktrees have different local changes; one is ready to rebase, and the other pushes a stash during that rebase.
- **Action:** Run the supported rebase command in the first worktree.
- **Expected:** The first worktree regains only its own changes, including its staged state; the other worktree's stash remains untouched. If restore conflicts, the saved object remains reachable and a repeat apply is refused.
- **Replayable offline:** yes (`scripts/tests/rebase-worktree.test.sh` uses a scratch repository).
