#!/usr/bin/env bash
# Rebase a linked worktree without using the shared refs/stash stack.
set -euo pipefail

usage() {
  echo "Usage: scripts/rebase-worktree.sh [--restore | --finish <saved-object-id>]" >&2
  exit 2
}

[[ $# -eq 0 || ( $# -eq 1 && $1 == --restore ) || ( $# -eq 2 && $1 == --finish ) ]] || usage

root=$(git rev-parse --show-toplevel)
cd "$root"
git_dir=$(cd "$(git rev-parse --git-dir)" && pwd -P)
common_dir=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
[[ $git_dir != "$common_dir" ]] || { echo "Refusing: use a linked task worktree." >&2; exit 2; }
branch=$(git symbolic-ref --quiet --short HEAD) || { echo "Refusing: detached HEAD." >&2; exit 2; }
[[ $branch != main ]] || { echo "Refusing: main is not a task worktree branch." >&2; exit 2; }

# Git stores refs/worktree separately for each linked worktree. A pending ref is
# durable across a failed rebase and cannot point at a different writer's stash.
saved_ref=refs/worktree/concierge-rebase-saved
attempted_ref=refs/worktree/concierge-rebase-restore-attempted

saved_object() {
  git rev-parse --verify --quiet "$saved_ref^{commit}"
}

refuse_active_rebase() {
  [[ ! -d $(git rev-parse --git-path rebase-merge) && ! -d $(git rev-parse --git-path rebase-apply) ]] || {
    echo "Refusing: resolve or abort the active rebase first." >&2
    exit 2
  }
}

release_saved_refs() {
  local oid=$1
  printf 'start\ndelete %s %s\ndelete %s %s\nprepare\ncommit\n' \
    "$attempted_ref" "$oid" "$saved_ref" "$oid" | git update-ref --stdin
}

restore_saved() {
  local saved_oid
  saved_oid=$(saved_object) || {
    echo "No saved rebase changes in this worktree." >&2
    exit 2
  }
  refuse_active_rebase
  if git rev-parse --verify --quiet "$attempted_ref" >/dev/null; then
    echo "Restore was already attempted. Resolve its partial changes, verify them against $saved_oid, then run scripts/rebase-worktree.sh --finish $saved_oid. The saved object remains pinned." >&2
    exit 2
  fi
  [[ -z $(git status --porcelain --untracked-files=normal) ]] || {
    echo "Refusing to restore into a dirty worktree. Resolve its current changes first; saved object: $saved_oid" >&2
    exit 2
  }
  # Mark the attempt before application. An interruption or conflict must not
  # make a second invocation apply the same changes over a partial result.
  git update-ref "$attempted_ref" "$saved_oid" ""
  if ! git stash apply --index "$saved_oid"; then
    echo "Restore conflicted. The exact saved object remains at $saved_ref: $saved_oid. Resolve the partial result; do not retry apply." >&2
    exit 1
  fi
  release_saved_refs "$saved_oid"
  echo "Restored this worktree's saved changes from $saved_oid." >&2
}

finish_restore() {
  local saved_oid attempted_oid
  saved_oid=$(saved_object) || { echo "No saved rebase changes in this worktree." >&2; exit 2; }
  attempted_oid=$(git rev-parse --verify --quiet "$attempted_ref^{commit}") || {
    echo "No partial restore to finish. Use --restore after the rebase." >&2
    exit 2
  }
  [[ $1 == "$saved_oid" && $attempted_oid == "$saved_oid" ]] || {
    echo "Refusing: provide the exact saved object ID shown by the failed restore." >&2
    exit 2
  }
  refuse_active_rebase
  [[ -z $(git ls-files -u) ]] || {
    echo "Refusing: unresolved merge paths remain; saved object stays pinned." >&2
    exit 2
  }
  [[ -n $(git status --porcelain --untracked-files=normal) ]] || {
    echo "Refusing: the worktree is clean, so no resolved changes are visible. The saved object stays pinned." >&2
    exit 2
  }
  release_saved_refs "$saved_oid"
  echo "Marked the manually resolved restore complete for $saved_oid." >&2
}

if [[ ${1:-} == --restore ]]; then
  restore_saved
  exit 0
fi
if [[ ${1:-} == --finish ]]; then
  finish_restore "$2"
  exit 0
fi

if git rev-parse --verify --quiet "$saved_ref" >/dev/null; then
  echo "Refusing: this worktree already has saved rebase changes. Resolve the rebase, then run scripts/rebase-worktree.sh --restore." >&2
  exit 2
fi

refuse_active_rebase

git fetch origin main

# stash create returns an object ID without touching the shared stash reflog.
# It captures tracked/index changes. Refuse untracked files before changing
# anything, because stash create cannot capture them.
if [[ -n $(git ls-files --others --exclude-standard) ]]; then
  echo "Refusing: untracked files are present. Commit or stage them before rebasing so they are preserved." >&2
  exit 2
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  saved_oid=$(git stash create "concierge-rebase:$branch")
  [[ -n $saved_oid ]] || { echo "Could not capture tracked changes; worktree untouched." >&2; exit 1; }
  git update-ref "$saved_ref" "$saved_oid" ""
  git restore --staged --worktree :/
  echo "Saved tracked changes for this worktree at $saved_ref: $saved_oid" >&2
fi

if [[ -n $(git status --porcelain --untracked-files=normal) ]]; then
  echo "Refusing rebase: worktree did not become clean; saved object remains at $saved_ref." >&2
  git status --short >&2
  exit 1
fi

if ! git rebase --no-autostash origin/main; then
  echo "Rebase stopped. Resolve or abort it; saved changes remain at $saved_ref. Run scripts/rebase-worktree.sh --restore only after the worktree is clean." >&2
  exit 1
fi

if git rev-parse --verify --quiet "$saved_ref" >/dev/null; then
  restore_saved
fi
