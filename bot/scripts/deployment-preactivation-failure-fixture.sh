#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/deploy.sh"

trace=$(mktemp)
trap 'rm -f "$trace"' EXIT
candidate=1111111111111111111111111111111111111111
healthy=2222222222222222222222222222222222222222
BUN_BIN=mock_bun
RELEASE_MANAGER_SCRIPT=release-manager
DEPLOY_STATE_SCRIPT=deploy-state
DEPLOY_RUN_ID=fixture-run
SERVICE=fixture-service
FAILED_COMMAND_EVIDENCE_DIR=""

mock_bun() {
  printf '%s\n' "bun:$3" >> "$trace"
  case "$3" in
    current)
      if [ "$mode" = matching ] || [ "$mode" = matching_stopped ]; then
        printf '{"artifact_path":"/release/healthy","git_commit":"%s"}\n' "$healthy"
      else
        printf '{"artifact_path":"/release/candidate","git_commit":"%s"}\n' "$candidate"
      fi ;;
    lkg|restore-lkg)
      printf '{"artifact_path":"/release/healthy","git_commit":"%s"}\n' "$healthy" ;;
    repair-begin)
      printf '{"incident_id":"fixture-incident","unit_name":"fixture-repair.service"}\n' ;;
    *) return 1 ;;
  esac
}
stop_release_owner() { printf '%s\n' stop >> "$trace"; RELEASE_OWNER_HEALTH_PENDING=1; }
start_unit() { printf '%s\n' start >> "$trace"; }
restart_unit() { printf '%s\n' restart >> "$trace"; }
probe_service() {
  printf '%s\n' probe >> "$trace"
  [ "$DEPLOYED_COMMIT" = "$healthy" ] && [ "${force_failed_probe:-0}" = 0 ]
}
release_deployment_gate() { printf '%s\n' release_gate >> "$trace"; }
recover_abandoned_gates() { printf '%s\n' recover_gates >> "$trace"; }
copy_failed_command_output_into_incident() { :; }
record_deployment_failure() { printf '%s\n' terminalize_run >> "$trace"; }
install_systemd_unit() {
  printf '%s\n' "install_unit:$*" >> "$trace"
  [ "${fail_repair_install:-0}" != 1 ]
}
systemctl() {
  printf '%s\n' "systemctl:$*" >> "$trace"
  if [ "$1" = is-active ]; then
    if [ "$mode" = matching_stopped ]; then printf '%s\n' inactive; else printf '%s\n' active; fi
    return 0
  fi
  if [ "$1" = start ] && [ "${fail_repair_start:-0}" = 1 ]; then return 1; fi
  if [ "$1" = daemon-reload ] && [ "${fail_repair_daemon:-0}" = 1 ]; then return 1; fi
}

reset_case() {
  : > "$trace"
  CURRENT_DEPLOY_STAGE=candidate-activation
  RELEASE_OWNER_HEALTH_PENDING=0
  DEPLOYED_COMMIT="$candidate"
  FAILED_CANDIDATE_COMMIT=""
  DEPLOY_RUN_TERMINAL=0
  REPAIR_LAUNCH_PENDING=0
  DEPLOY_FAILURE_REASON='candidate preparation refused'
  LAST_FAILED_COMMAND=prepare
  force_failed_probe=0
  fail_repair_start=0
  fail_repair_install=0
  fail_repair_daemon=0
}

reset_case
mode=matching
handoff_failed_deployment_to_repair 1 candidate-preparation
rg -q '^probe$' "$trace"
rg -q '^release_gate$' "$trace"
rg -q '^systemctl:start fixture-repair.service$' "$trace"
if rg -q '^(stop|start|restart|bun:restore-lkg)$' "$trace"; then
  echo 'A failed preactivation check interrupted a healthy serving release.' >&2
  exit 1
fi

reset_case
mode=different
handoff_failed_deployment_to_repair 1 candidate-activation
sequence=$(rg '^(stop|bun:restore-lkg|start|probe)$' "$trace" | paste -sd ' ' -)
if [ "$sequence" != 'stop bun:restore-lkg start probe' ]; then
  echo "Recovery did not start the restored owner before probing it: $sequence" >&2
  exit 1
fi

reset_case
mode=matching_stopped
handoff_failed_deployment_to_repair 1 candidate-preparation
sequence=$(rg '^(stop|bun:restore-lkg|start|probe)$' "$trace" | paste -sd ' ' -)
if [ "$sequence" != 'stop bun:restore-lkg start probe' ]; then
  echo "A stopped owner waited in a health probe before restoration: $sequence" >&2
  exit 1
fi

reset_case
mode=matching
force_failed_probe=1
handoff_failed_deployment_to_repair 1 candidate-preparation
sequence=$(rg '^(stop|bun:restore-lkg|start|probe)$' "$trace" | head -5 | paste -sd ' ' -)
if [ "$sequence" != 'probe stop bun:restore-lkg start probe' ]; then
  echo "Unhealthy serving owner was not restored and started before probing: $sequence" >&2
  exit 1
fi

reset_case
mode=matching
fail_repair_start=1
if ! handoff_failed_deployment_to_repair 1 candidate-preparation; then
  echo 'A durable repair incident was discarded after its service refused to start.' >&2
  exit 1
fi
if [ "$REPAIR_LAUNCH_PENDING" != 1 ] || [ "$DEPLOY_RUN_TERMINAL" != 1 ]; then
  echo 'A failed repair-service start did not retain its runnable incident for the deployment worker.' >&2
  exit 1
fi

reset_case
mode=matching
fail_repair_start=1
PRESERVE_GATES_ON_FAILURE=0
PREFLIGHT_REFUSED=0
(cleanup_failed_deployment)
if rg -q '^terminalize_run$' "$trace"; then
  echo 'Outer cleanup terminalized a run with a durable, runnable repair incident.' >&2
  exit 1
fi

for blocked_step in install daemon; do
  reset_case
  mode=matching
  if [ "$blocked_step" = install ]; then fail_repair_install=1; else fail_repair_daemon=1; fi
  (cleanup_failed_deployment)
  if rg -q '^terminalize_run$' "$trace"; then
    echo "Outer cleanup terminalized the durable incident after $blocked_step refusal." >&2
    exit 1
  fi
done
echo 'deployment preactivation failure: serving owner retained; restored owner started before probe'
