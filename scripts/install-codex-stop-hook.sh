#!/usr/bin/env bash
# Source-owned entrypoint for every supported Concierge managed-hook installation.
# The durable owner helper acquires a machine-wide config intent before it starts the
# installer body and keeps that intent unresolved if the child does not complete cleanly.
set -euo pipefail

bun= bot= state= release=
args=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --bun) bun=$2; shift 2 ;;
    --bot) bot=$2; shift 2 ;;
    --release) release=$2; shift 2 ;;
    --state) state=$2; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -x "$bun" ] || { echo "No bun runtime at: $bun" >&2; exit 2; }
[ -d "$state" ] || { echo "No Concierge state directory: $state" >&2; exit 2; }
if [ -n "$release" ]; then
  control=$(cd "$(dirname "$0")" && pwd -P)
  helper="$control/bot/scripts/codex-managed-hook-install.js"
  body="$control/install-codex-stop-hook-body.sh"
else
  [ -d "$bot" ] || { echo "No Concierge bot directory: $bot" >&2; exit 2; }
  project=$(cd "$(dirname "$bot")" && pwd -P)
  helper="$bot/scripts/codex-managed-hook-install.ts"
  body="$project/scripts/install-codex-stop-hook-body.sh"
fi
[ -f "$helper" ] && [ -f "$body" ] || { echo "Managed hook installer helper or body is missing." >&2; exit 2; }
CONCIERGE_STATE_DIR="$state" "$bun" run "$helper" --body "$body" -- "${args[@]}"
