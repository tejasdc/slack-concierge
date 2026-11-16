#!/usr/bin/env bash
# Merge one checked pull request into main through the machine's merge lane.
#
# The default-branch ruleset requires the Release check on a branch that is up to
# date with main, so the check always ran on exactly the tree main becomes. When
# several agents merge at once, each merge makes every other checked branch stale.
# GitHub's merge queue would serialise this, but GitHub refuses it for
# repositories owned by a personal account. This lane serialises instead: one
# holder at a time brings its branch up to date with an ordinary merge commit,
# waits for the required check on that exact commit, and merges it. Merges made
# outside the lane are tolerated; the holder simply brings its branch up to date
# again. Nothing here weakens the check or rewrites published history.
set -euo pipefail

usage() {
  echo "Usage: scripts/merge-pr.sh <pull-request-number> [--wait-minutes <n>]" >&2
  exit 2
}

[[ $# -ge 1 && $1 =~ ^[0-9]+$ ]] || usage
pr=$1; shift
wait_minutes=90
while [[ $# -gt 0 ]]; do
  case $1 in
    --wait-minutes) [[ ${2:-} =~ ^[0-9]+$ ]] || usage; wait_minutes=$2; shift 2 ;;
    *) usage ;;
  esac
done

required_check="Release check"
check_timeout_seconds=1200
max_attempts=8
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
lock_dir=${CONCIERGE_MERGE_LANE_DIR:-/run/lock}
lock_file="$lock_dir/merge-lane-${repo//\//-}.lock"
holder_file="$lock_file.holder"

say() { printf '[merge lane %s #%s] %s\n' "$(date -u +%H:%M:%SZ)" "$pr" "$*" >&2; }

exec 9>>"$lock_file"
if ! flock -n 9; then
  say "waiting for the lane; current holder: $(cat "$holder_file" 2>/dev/null || echo unknown)"
  flock -w $((wait_minutes * 60)) 9 || { say "gave up after $wait_minutes minutes waiting for the lane"; exit 1; }
fi
printf 'PR #%s, pid %s, since %s\n' "$pr" "$$" "$(date -u +%FT%TZ)" > "$holder_file"
say "holding the lane"

pr_field() { gh pr view "$pr" --repo "$repo" --json "$1" --jq ".$1"; }

# Prints success, failure, or pending for the required check on one commit.
# Both the branch push and the pull request event report a run on the head
# commit; wait for every run that has appeared, and for the second one briefly.
check_state() {
  local sha=$1 first_seen=$2
  local runs
  runs=$(gh api "repos/$repo/commits/$sha/check-runs?check_name=$(printf %s "$required_check" | jq -sRr @uri)&per_page=20" \
    --jq '[.check_runs[] | {status, conclusion}]')
  local total incomplete failed
  total=$(jq length <<<"$runs")
  incomplete=$(jq '[.[] | select(.status != "completed")] | length' <<<"$runs")
  failed=$(jq '[.[] | select(.status == "completed" and .conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral")] | length' <<<"$runs")
  if (( failed > 0 )); then echo failure
  elif (( total == 0 || incomplete > 0 )); then echo pending
  elif (( total < 2 && $(date +%s) - first_seen < 60 )); then echo pending
  else echo success
  fi
}

for (( attempt = 1; attempt <= max_attempts; attempt++ )); do
  state=$(pr_field state)
  case $state in
    MERGED) say "already merged"; exit 0 ;;
    CLOSED) say "the pull request is closed"; exit 1 ;;
  esac
  [[ $(pr_field isDraft) == false ]] || { say "the pull request is a draft"; exit 1; }
  head=$(pr_field headRefOid)
  base=$(pr_field baseRefName)
  behind=$(gh api "repos/$repo/compare/$base...$head" --jq .behind_by)

  if (( behind > 0 )); then
    say "branch is $behind commit(s) behind $base; merging $base into it"
    if ! gh api -X PUT "repos/$repo/pulls/$pr/update-branch" -f expected_head_sha="$head" >/dev/null; then
      say "GitHub could not merge $base into the branch (likely a conflict). Merge origin/$base in the worktree, resolve, push, and run this again."
      exit 1
    fi
    for _ in $(seq 1 60); do
      [[ $(pr_field headRefOid) != "$head" ]] && break
      sleep 2
    done
    continue
  fi

  say "waiting for $required_check on ${head:0:12}"
  first_seen=$(date +%s)
  deadline=$(( first_seen + check_timeout_seconds ))
  while :; do
    result=$(check_state "$head" "$first_seen")
    [[ $result != pending ]] && break
    (( $(date +%s) < deadline )) || { say "$required_check did not finish in $((check_timeout_seconds / 60)) minutes"; exit 1; }
    sleep 15
  done
  if [[ $result == failure ]]; then
    say "$required_check failed on ${head:0:12}; see https://github.com/$repo/pull/$pr/checks"
    exit 1
  fi

  if gh pr merge "$pr" --repo "$repo" --merge --match-head-commit "$head" >/dev/null; then
    say "merged at $(gh pr view "$pr" --repo "$repo" --json mergeCommit --jq .mergeCommit.oid)"
    exit 0
  fi
  say "merge refused (main probably moved outside the lane); trying again"
done

say "gave up after $max_attempts attempts"
exit 1
