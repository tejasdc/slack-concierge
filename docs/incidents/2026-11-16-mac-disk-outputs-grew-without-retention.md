---
failure: Concierge's Mac log grew to 2.5 GB without rotation while old empty staging files and finished worktrees accumulated.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Mac outputs grew without retention

Source request `d762bb7e-0076-4a7c-9409-9a62a44116a5`, source run
`76b699f5-a95d-4de1-b301-94f0a0062c09`, Concierge session 9927.

## What was seen

The source report found 216 MB free before a separate agent reclaimed a stale iPhone
debug cache. It named a 2.5 GB Concierge log, 612 empty identity staging files and
finished Mac worktrees without retirement. This repair does not attribute the whole
disk incident to Concierge. A current native read confirmed a 2.3 GiB main log,
34 MiB error log and 18 GiB available after that earlier reclaim.

## Cause

Confirmed defect: bounded application logging limits its memory and backpressure,
while launchd's regular output files previously had no retention. Existing upkeep
also had no empty-staging sweep or proof-bound finished-worktree retirement.

## Fix

Existing Mac upkeep now retains compressed log generations, sweeps exactly scoped
empty identity leftovers, retires only proven finished worktrees through Trash and
delivers a stable pressure warning through the authenticated server peer. Failed
compression never expires prior archives; interrupted publication holds further
rotation and records a repair notice. Submodules and path aliases refuse retirement.

Replay: `python3 scripts/mac-disk-maintenance-test.py`. The disposable acceptance
keeps an append descriptor open across real rotation and tests archive failure,
scoped deletion, Git proof boundaries, branch preservation and uncertain notice
retry. The [current runbook](../runbooks/MAC-DISK-MAINTENANCE.md) owns runtime policy.
Installed native behavior and observed notification delivery must be reported
separately from this source-level reproduction.

## Acceptance scenario

- **Seed:** Disposable output log above its retention threshold with an open append
  descriptor, an old empty owned 0600 identity staging file, clean/dirty/unmerged/
  busy worktrees, and a disposable server Inbox ledger.
- **Action:** Run the real retention and retirement predicates, then submit the same
  authenticated disk-pressure episode twice through the real gateway and owner.
- **Expected:** The inode continues accepting output, first evidence archive remains
  readable, later generations stay bounded, only eligible staging/finished work is
  removed or moved to Trash, branch remains, and the server records one Inbox input
  and one attention item. Unauthenticated/spoofed calls make no notice.
- **Replayable offline:** yes; `python3 scripts/mac-disk-maintenance-test.py`,
  `bun bot/scripts/mac-disk-notice-fixture.ts`, and
  `bun bot/scripts/mac-disk-warning-ingress-fixture.ts` use disposable state and no provider.
