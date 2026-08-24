---
title: "Refactor: Drive Canvas projection from committed AGENTS.md changes"
type: refactor
date: 2026-08-24
---

# Drive Canvas projection from committed AGENTS.md changes

## Goal

Make tracked Git `AGENTS.md` commits the only ordinary trigger for channel Canvas projection. Remove provider-turn fingerprint checks and the six-hour fleet rewrite. Reuse one file-event/coalescing primitive for TODO projection and Git-HEAD projection so later source-driven projections do not duplicate watcher lifecycle code.

The operating profile is one personal Slack workspace with 58 visible channels, currently 54 backed by tracked `AGENTS.md` files. Untracked, missing, and vault-only sources are outside this change. The rollout may project each tracked channel once to establish its last confirmed Git commit; healthy idle cost after that is zero.

## Contract

- Git is the canonical version boundary for managed-project `AGENTS.md` files.
- A reusable watcher observes a resolved file target, coalesces events per channel, invokes one projection callback, and applies only the configured retry policy.
- The Canvas watcher observes the current worktree's Git HEAD/reflog path, not `AGENTS.md` and not provider turns.
- On startup and HEAD movement, a path-scoped Git comparison determines whether `AGENTS.md` differs between the last confirmed Canvas commit and current `HEAD`.
- Unrelated commits and committed change-then-revert histories cause no Slack call.
- A changed Canvas is rendered from `HEAD:AGENTS.md`, never from uncommitted working-tree bytes.
- Slack success advances one per-channel commit-SHA cursor. Failure leaves the old cursor and does not create recurring idle retry work.
- Channel creation and persisted `canvas_required` cutovers retain their existing forced projection behavior and Canvas serialization/rate-limit boundaries.

## Non-goals

- Supporting, repairing, or migrating untracked, missing, or vault-only `AGENTS.md` sources.
- Installing Git hooks, polling repositories, watching working-tree edits, or projecting uncommitted instructions.
- Detecting Slack-only Canvas edits or deletion without a later committed source change.
- Generalizing beyond the known file-watch, coalescing, and retry variation used by TODO and Canvas projections.

## Implementation

- [x] Extract the watch-target, per-channel coalescing, debounce, optional retry, rebind, and shutdown behavior from `TodoFileWatcher` into one reusable projection watcher.
- [x] Configure TODO projection through that watcher without changing its path, capture hints, startup comparison, or retry behavior.
- [x] Add a Git-backed `AGENTS.md` source resolver that identifies tracked `HEAD:AGENTS.md`, resolves the worktree HEAD event path, performs a path-scoped commit comparison, and reads committed content without a shell.
- [x] Persist only the last successfully projected Git commit SHA beside channel Canvas state.
- [x] Add a Canvas commit projection manager that no-ops on unrelated HEAD movement, advances an equivalent cursor without Slack, projects exact committed content when changed or missing locally, and advances the cursor only after confirmed Slack success.
- [x] Start and close the Canvas commit watcher with the existing runtime lifecycle; add newly created tracked channels to it.
- [x] Remove turn-start/turn-end `AGENTS.md` reads, the post-turn Canvas scheduling seam, and the six-hour Canvas sweep.
- [x] Preserve forced channel-creation and `canvas_required` refresh paths.
- [x] Update current-state Canvas and lifecycle documentation in the same commit.

## Verification

- [x] Prove the reusable watcher coalesces file events, rebinds when a resolved watch target changes, closes cleanly, and retries only when configured.
- [x] Retain TODO atomic-replacement, explicit scheduling, and retry tests through the shared watcher.
- [x] Prove tracked Git resolution, exact committed reads, unrelated-commit no-op, committed `AGENTS.md` projection, change-then-revert no-op, uncommitted-edit exclusion, startup catch-up, and failure cursor retention.
- [x] Prove Canvas create/edit still receives normalized Markdown and same-channel operations remain serialized.
- [x] Prove turn execution no longer reads or schedules Canvas work and artifact/session FIFO behavior remains intact.
- [x] Prove normal runtime no longer installs a recurring Canvas sweep while strict `canvas_required` startup remains fail closed.
- [x] Run focused tests during implementation, the full Bun milestone gate (with one correction rerun), and a production Bun build.
- [x] Obtain one fresh-context simplicity review of the actual diff with an explicit `SHIP` or `NO-SHIP` verdict.
- [ ] Rebase on current `origin/main`, commit, push, integrate the reviewed tree, and hand deployment to `bot/scripts/deploy.sh` without polling Concierge.

## Rollback

Revert the integrated commit and deploy through the ordinary detached workflow. Existing Canvas IDs and content remain valid projection state; the prior startup/interval/post-turn behavior resumes without a data migration rollback.
