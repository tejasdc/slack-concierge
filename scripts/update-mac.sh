#!/usr/bin/env bash
# Update the Mac Concierge to origin/main and restart it. Runs as its own launchd job
# (com.tejasdc.concierge-update) so the restart never kills the process doing it; see
# docs/runbooks/PEER-INSTANCES.md. Refuses a dirty checkout or a branch other than main.
#
# --when-due is the automatic path (com.tejasdc.concierge-autoupdate, every fifteen minutes and
# after a wake): it updates only when main has moved and nothing is running on this Mac, holding
# new work for the few minutes the restart takes and never interrupting a running turn. The Mac
# sat four days behind main because an update needed someone to remember it (2026-09-29).
set -euo pipefail
cd "$(dirname "$0")/.."
STATE=${CONCIERGE_MAC_STATE_DIR:-"$HOME/Library/Application Support/concierge"}
BUN="$STATE/bun/bin/bun"
drain() { (cd bot && CONCIERGE_STATE_DIR="$STATE" "$BUN" scripts/drain-status.ts "$@"); }
# Quiet means no live turn: 0 drained, 20 only turns whose process already died (startup recovers those).
quiet() { local code=0; drain check "$@" >/dev/null || code=$?; [ "$code" -eq 0 ] || [ "$code" -eq 20 ]; }

# The whole run is one function, parsed before it starts: the pull below can rewrite this file.
main() {
  branch=$(git rev-parse --abbrev-ref HEAD)
  [ "$branch" = main ] || { echo "Refusing: checkout is on $branch, not main." >&2; exit 2; }
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Refusing: checkout has uncommitted changes." >&2; git status --short >&2; exit 2; }

  # The automatic path (--when-due) tries only when main has moved; an update someone asked for
  # tries now. Both go through the same gate: the flag decides when to try, never whether running
  # work is protected.
  when_due=0; [ "${1:-}" = --when-due ] && when_due=1
  # His decisions record travels by git too; the pre-commit check on this Mac reads it.
  [ "$when_due" = 1 ] && { git -C "$HOME/workspace/decision-record" pull --ff-only --quiet >/dev/null 2>&1 || true; }
  git fetch --quiet origin
  # The one revision this run checks and installs; nothing below fetches again.
  candidate=$(git rev-parse origin/main)
  if [ "$when_due" = 1 ] && [ "$(git rev-parse HEAD)" = "$candidate" ]; then exit 0; fi
  git merge-base --is-ancestor HEAD "$candidate" || { echo "Refusing: this checkout has commits main does not; nothing changed." >&2; exit 2; }
  echo "== $(date -u +%FT%TZ) installing $(git log --oneline -1 "$candidate"); checking for running work"
  # Look first without holding anything, so a busy Mac is never made to wait for an update.
  if ! quiet; then
    # Concierge reads this to tell the agents it waits for, and Tejas, once it has waited 15 minutes.
    # The wait began at the first busy check, whatever main has moved to since.
    waiting_since=$(sed -n 's/.*"since":\([0-9]*\).*/\1/p' "$STATE/update-waiting.json" 2>/dev/null || true)
    printf '{"candidate":"%s","since":%s}\n' "$candidate" "${waiting_since:-$(date +%s)}" > "$STATE/update-waiting.json.tmp" && mv "$STATE/update-waiting.json.tmp" "$STATE/update-waiting.json"
    echo "   work is running here that would not survive the restart; the automatic update tries again at the next interval"; exit 0
  fi
  claim=$(drain claim --owner-pid $$) || { echo "   another update holds the gate: $claim"; exit 0; }
  token=$(printf '%s' "$claim" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  if ! quiet "$token"; then
    drain release "$token" >/dev/null
    echo "   work started while claiming; released and trying again at the next interval"
    exit 0
  fi
  # New work waits (it is queued, not refused) from here until the restarted Concierge is up.
  trap 'drain release "$token" >/dev/null 2>&1 || true' EXIT
  # Agents may still be running in execution hosts. Before anything changes, the candidate must be
  # able to take back every host they and this Concierge speak; a Mac has no rollback release.
  contracts=$(mktemp -d)
  if ! git show "$candidate:bot/src/host-protocols.json" > "$contracts/candidate.json"; then
    echo "   the update's host-protocol contract could not be read; nothing changed"; exit 0
  fi
  if [ -f bot/src/host-protocols.json ]; then cp bot/src/host-protocols.json "$contracts/running.json"
  else printf '{"current":null,"adoptable":[]}' > "$contracts/running.json"; fi
  if ! drain adoptable-check --candidate-contract "$contracts/candidate.json" --running-contract "$contracts/running.json" --no-rollback; then
    echo "   the update cannot take back agents running here; nothing changed"; exit 0
  fi
  rm -f "$STATE/update-waiting.json"
  git merge --ff-only --quiet "$candidate"
  [ "$(git rev-parse HEAD)" = "$candidate" ] || { echo "Refusing: the checkout is not at the checked revision." >&2; exit 2; }
  echo "== at $(git log --oneline -1)"
  # The installer restarts Concierge only with this gate's proof for exactly this revision.
  CONCIERGE_UPDATE_GATE_TOKEN="$token" CONCIERGE_UPDATE_CANDIDATE="$candidate" scripts/install-mac.sh
}
main "$@"
exit $?
