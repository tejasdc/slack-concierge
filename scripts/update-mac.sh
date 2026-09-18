#!/usr/bin/env bash
# Update the Mac Concierge to origin/main and restart it. Runs as its own launchd job
# (com.tejasdc.concierge-update) so the restart never kills the process doing it; see
# docs/runbooks/PEER-INSTANCES.md. Refuses a dirty checkout or a branch other than main.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== $(date -u +%FT%TZ) update requested"
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || { echo "Refusing: checkout is on $branch, not main." >&2; exit 2; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Refusing: checkout has uncommitted changes." >&2; git status --short >&2; exit 2; }
git fetch --quiet origin
git pull --ff-only --quiet origin main
echo "== at $(git log --oneline -1)"
exec scripts/install-mac.sh
