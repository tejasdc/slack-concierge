#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "$0")/.." && pwd)/rebase-worktree.sh
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

git init --bare --initial-branch=main "$fixture/origin.git" >/dev/null
git clone "$fixture/origin.git" "$fixture/repo" >/dev/null 2>&1
repo=$fixture/repo
git -C "$repo" config user.name "Worktree test"
git -C "$repo" config user.email "worktree-test@example.invalid"
printf 'base\n' > "$repo/own.txt"
printf 'base\n' > "$repo/other.txt"
printf 'base\n' > "$repo/main.txt"
git -C "$repo" add .
git -C "$repo" commit -m base >/dev/null
git -C "$repo" push -u origin main >/dev/null 2>&1
git -C "$repo" worktree add -b feature "$fixture/feature" >/dev/null
git -C "$repo" worktree add -b other "$fixture/other" >/dev/null

printf 'new main\n' > "$repo/main.txt"
git -C "$repo" add main.txt
git -C "$repo" commit -m advance >/dev/null
git -C "$repo" push origin main >/dev/null 2>&1

printf 'my change\n' > "$fixture/feature/own.txt"
printf 'staged new file\n' > "$fixture/feature/new.txt"
git -C "$fixture/feature" add new.txt
printf 'other writer\n' > "$fixture/other/other.txt"

# This hook pushes another worktree's stash after feature has pinned its own
# object but before its rebase completes. A bare stash pop would select it.
printf '#!/bin/sh\nenv -i PATH="%s" HOME="%s" git -C "%s" stash push -m sibling >/dev/null\n' "$PATH" "$HOME" "$fixture/other" > "$repo/.git/hooks/pre-rebase"
chmod +x "$repo/.git/hooks/pre-rebase"
if ! (cd "$fixture/feature" && "$script") >"$fixture/rebase.log" 2>&1; then
  cat "$fixture/rebase.log" >&2
  exit 1
fi

[[ $(cat "$fixture/feature/own.txt") == 'my change' ]]
[[ $(cat "$fixture/feature/main.txt") == 'new main' ]]
[[ $(cat "$fixture/feature/new.txt") == 'staged new file' ]]
[[ $(git -C "$fixture/feature" status --porcelain) == $'A  new.txt\n M own.txt' ]]
[[ $(git -C "$fixture/feature" stash list -1 --format=%gs) == *sibling* ]]
! git -C "$fixture/feature" rev-parse --verify --quiet refs/worktree/concierge-rebase-saved >/dev/null

printf 'untracked\n' > "$fixture/feature/untracked.txt"
if (cd "$fixture/feature" && "$script") >/dev/null 2>&1; then
  echo 'Expected untracked-file refusal.' >&2
  exit 1
fi
[[ $(cat "$fixture/feature/untracked.txt") == 'untracked' ]]
[[ $(cat "$fixture/feature/own.txt") == 'my change' ]]
! git -C "$fixture/feature" rev-parse --verify --quiet refs/worktree/concierge-rebase-saved >/dev/null

# A failed rebase must leave the saved object reachable until the user aborts
# or resolves the conflict, then --restore must use that same object.
git -C "$repo" worktree add -b conflict "$fixture/conflict" "$(git -C "$repo" rev-list --max-parents=0 HEAD)" >/dev/null
printf 'feature commit\n' > "$fixture/conflict/own.txt"
git -C "$fixture/conflict" add own.txt
git -C "$fixture/conflict" commit -m 'feature commit' >/dev/null
printf 'saved work\n' > "$fixture/conflict/other.txt"
printf 'main commit\n' > "$repo/own.txt"
git -C "$repo" add own.txt
git -C "$repo" commit -m 'conflicting main' >/dev/null
git -C "$repo" push origin main >/dev/null 2>&1
if (cd "$fixture/conflict" && "$script") >"$fixture/conflict.log" 2>&1; then
  echo 'Expected a rebase conflict.' >&2
  exit 1
fi
saved_oid=$(git -C "$fixture/conflict" rev-parse --verify refs/worktree/concierge-rebase-saved)
[[ $(git -C "$fixture/conflict" show "$saved_oid:other.txt") == 'saved work' ]]
! git -C "$fixture/other" rev-parse --verify --quiet refs/worktree/concierge-rebase-saved >/dev/null
if (cd "$fixture/conflict" && "$script" --restore) >/dev/null 2>&1; then
  echo 'Expected restore refusal during a rebase.' >&2
  exit 1
fi
[[ $(git -C "$fixture/conflict" rev-parse --verify refs/worktree/concierge-rebase-saved) == "$saved_oid" ]]
git -C "$fixture/conflict" rebase --abort >/dev/null
(cd "$fixture/conflict" && "$script" --restore) >/dev/null 2>&1
[[ $(cat "$fixture/conflict/other.txt") == 'saved work' ]]
! git -C "$fixture/conflict" rev-parse --verify --quiet refs/worktree/concierge-rebase-saved >/dev/null

# When applying the saved object conflicts after a successful rebase, preserve
# it and forbid a repeat apply over the partial result.
git -C "$repo" worktree add -b apply-conflict "$fixture/apply-conflict" >/dev/null
printf 'local edit\n' > "$fixture/apply-conflict/own.txt"
printf 'new main edit\n' > "$repo/own.txt"
git -C "$repo" add own.txt
git -C "$repo" commit -m 'advance for restore conflict' >/dev/null
git -C "$repo" push origin main >/dev/null 2>&1
if (cd "$fixture/apply-conflict" && "$script") >"$fixture/apply-conflict.log" 2>&1; then
  echo 'Expected saved-change application to conflict.' >&2
  exit 1
fi
saved_oid=$(git -C "$fixture/apply-conflict" rev-parse --verify refs/worktree/concierge-rebase-saved)
[[ $(git -C "$fixture/apply-conflict" rev-parse --verify refs/worktree/concierge-rebase-restore-attempted) == "$saved_oid" ]]
if (cd "$fixture/apply-conflict" && "$script" --restore) >/dev/null 2>&1; then
  echo 'Expected repeat-apply refusal.' >&2
  exit 1
fi
if (cd "$fixture/apply-conflict" && "$script" --finish "$saved_oid") >/dev/null 2>&1; then
  echo 'Expected unresolved-path refusal.' >&2
  exit 1
fi
git -C "$fixture/apply-conflict" restore --source=HEAD --staged --worktree -- own.txt
if (cd "$fixture/apply-conflict" && "$script" --finish "$saved_oid") >/dev/null 2>&1; then
  echo 'Expected clean-tree finish refusal.' >&2
  exit 1
fi
printf 'resolved local edit\n' > "$fixture/apply-conflict/own.txt"
git -C "$fixture/apply-conflict" add own.txt
(cd "$fixture/apply-conflict" && "$script" --finish "$saved_oid") >/dev/null 2>&1
[[ $(cat "$fixture/apply-conflict/own.txt") == 'resolved local edit' ]]
! git -C "$fixture/apply-conflict" rev-parse --verify --quiet refs/worktree/concierge-rebase-saved >/dev/null
! git -C "$fixture/apply-conflict" rev-parse --verify --quiet refs/worktree/concierge-rebase-restore-attempted >/dev/null

echo 'rebase-worktree: sibling stash isolation, refusal paths, and both recovery paths passed'
