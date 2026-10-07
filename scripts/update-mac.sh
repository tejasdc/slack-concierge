#!/usr/bin/env bash
# Update the Mac Concierge to origin/main and restart it. Runs as its own launchd job
# (com.tejasdc.concierge-update) so the restart never kills the process doing it; see
# docs/runbooks/PEER-INSTANCES.md. Refuses a dirty checkout or a branch other than main.
#
# --when-due is the automatic path (com.tejasdc.concierge-autoupdate, every fifteen minutes and
# after a wake): when main has moved it holds new work (queued, not refused) while running turns
# finish, never interrupting one, then updates. The Mac
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

  if [ "${1:-}" = --when-due ]; then
    # His decisions record travels by git too; the pre-commit check on this Mac reads it.
    git -C "$HOME/workspace/decision-record" pull --ff-only --quiet >/dev/null 2>&1 || true
    git fetch --quiet origin
    [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] || exit 0
    echo "== $(date -u +%FT%TZ) main moved to $(git log --oneline -1 origin/main); checking for running work"
    claim=$(drain claim --owner-pid $$) || { echo "   another update holds the gate: $claim"; exit 0; }
    token=$(printf '%s' "$claim" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    # New work waits (it is queued, not refused) from here until the restarted Concierge is up,
    # and running turns finish untouched. Giving up whenever anything ran let a busy Mac skip
    # update after update, the same starvation the server had (2026-10-07).
    trap 'drain release "$token" >/dev/null 2>&1 || true' EXIT
    if ! quiet "$token"; then
      echo "   work is running here; new work now queues for this update while it finishes"
      while :; do
        code=0; drain check "$token" >/dev/null || code=$?
        case "$code" in 0|20) break ;; 10) sleep 20 ;; *) echo "   the update gate was lost ($code); trying again at the next interval"; exit 0 ;; esac
      done
      echo "   running work finished; updating"
    fi
    git pull --ff-only --quiet origin main
    echo "== at $(git log --oneline -1)"
    scripts/install-mac.sh
    exit 0
  fi

  echo "== $(date -u +%FT%TZ) update requested"
  git fetch --quiet origin
  git pull --ff-only --quiet origin main
  echo "== at $(git log --oneline -1)"
  exec scripts/install-mac.sh
}
main "$@"
exit $?
