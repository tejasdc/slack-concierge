#!/usr/bin/env bash
# One-time coordinated cutover for canonical managed-project instructions.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
export CONCIERGE_PROJECT_SCAFFOLD_CUTOVER=1
export CONCIERGE_PRESERVE_GATES_ON_FAILURE=1

# shellcheck source=deploy.sh
source "$SCRIPT_DIR/deploy.sh"

run_project_scaffold_cutover() {
  local reviewed_exceptions=${1:-}
  local report_dir first_report second_report
  cd "$REPO"
  verify_git_origin
  report_dir="$STATE_DIR/project-scaffold-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
  first_report="$report_dir/apply.json"
  second_report="$report_dir/idempotency.json"
  install -d -m 0700 "$report_dir"

  prepare_capture_identity
  claim_deployment_gate
  trap cleanup_failed_deployment EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  "$BUN_BIN" run "$REPO/bot/scripts/project-scaffold-cutover-state.ts" begin
  hold_capture_gate

  echo "=== stop the drained old Canvas authority ==="
  systemctl stop "$SERVICE"

  local migration_command=(
    "$BUN_BIN" run "$REPO/bot/scripts/migrate-project-scaffolds.ts"
    --apply --propagate-git --pause-sync
  )
  if [ -n "$reviewed_exceptions" ]; then
    migration_command+=(--reviewed-exceptions "$reviewed_exceptions")
  fi

  echo "=== apply reviewed scaffold inventory and propagate exact Git changes ==="
  "${migration_command[@]}" | tee "$first_report"
  jq -e '.authorizedApply and .registryUnchanged and .git.ok and .migration.applied and (.migration.partial | not) and .migration.exceptionsAccepted' "$first_report" >/dev/null

  echo "=== prove second-run idempotency against the same reviewed exceptions ==="
  "${migration_command[@]}" | tee "$second_report"
  jq -e '.authorizedApply and .registryUnchanged and .git.ok and .migration.applied and (.migration.partial | not) and .migration.exceptionsAccepted and (.migration.counts.migrated == 0)' "$second_report" >/dev/null

  echo "=== require all Slack-visible Canvas refresh before Slack admission reopens ==="
  "$BUN_BIN" run "$REPO/bot/scripts/project-scaffold-cutover-state.ts" canvas-required
  deploy
  "$BUN_BIN" run "$REPO/bot/scripts/project-scaffold-cutover-state.ts" complete
  echo "Project scaffold cutover evidence: $report_dir"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  reviewed_exceptions=""
  if [ "${1:-}" = "--reviewed-exceptions" ]; then
    [ -n "${2:-}" ] || { echo "--reviewed-exceptions requires a manifest path" >&2; exit 2; }
    reviewed_exceptions=$2
    shift 2
  fi
  [ "$#" -eq 0 ] || { echo "usage: project-scaffold-cutover.sh [--reviewed-exceptions PATH]" >&2; exit 2; }
  run_project_scaffold_cutover "$reviewed_exceptions"
fi
