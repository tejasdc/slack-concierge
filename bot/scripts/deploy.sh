#!/usr/bin/env bash
# Concierge deploy — the only supported path to update the service peer.

set -euo pipefail

export HOME=${HOME:-/root}
export GIT_TERMINAL_PROMPT=0

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REPO=${CONCIERGE_REPO:-$SCRIPT_ROOT}
SERVICE=${CONCIERGE_SERVICE:-concierge-bot}
STATE_DIR=${CONCIERGE_STATE_DIR:-/root/.local/state/concierge}
APPLICATION_SOURCE_STATE_DIR=$STATE_DIR
APPLICATION_TARGET_STATE_DIR=${CONCIERGE_APPLICATION_TARGET_STATE_DIR:-/var/lib/concierge-bot/state}
APPLICATION_CUTOVER_ID=${CONCIERGE_APPLICATION_CUTOVER_ID:-}
APPLICATION_CUTOVER_RESUME=${CONCIERGE_APPLICATION_CUTOVER_RESUME:-0}
APPLICATION_CUTOVER_SCRIPT="$REPO/bot/scripts/deployment-repair/application-cutover.ts"
CAPTURE_SERVICE=${CONCIERGE_CAPTURE_SERVICE:-agent-inbox.service}
CAPTURE_STATE_DIR=${CONCIERGE_CAPTURE_STATE_DIR:-/var/lib/concierge-capture}
CAPTURE_AUDIO_DIR=${CONCIERGE_CAPTURE_AUDIO_DIR:-/var/agent-inbox}
CAPTURE_USER=${CONCIERGE_CAPTURE_USER:-concierge-capture}
CAPTURE_RUNTIME_DIR=${CONCIERGE_CAPTURE_RUNTIME_DIR:-/usr/local/lib/slack-concierge}
CAPTURE_CONFIG_DEST=${CONCIERGE_CAPTURE_CONFIG_DEST:-/etc/concierge/capture-routes.toml}
SYSUSERS_DIR=${CONCIERGE_SYSUSERS_DIR:-/etc/sysusers.d}
TMPFILES_DIR=${CONCIERGE_TMPFILES_DIR:-/etc/tmpfiles.d}
BUN_BIN=${CONCIERGE_BUN_BIN:-/root/.bun/bin/bun}
DRAIN_INTERVAL_SECONDS=${CONCIERGE_DRAIN_INTERVAL_SECONDS:-1200}
SYSTEMD_DIR=${CONCIERGE_SYSTEMD_DIR:-/etc/systemd/system}
ROUTER_ACTIONS_DEST=${CONCIERGE_ROUTER_ACTIONS_DEST:-/root/.local/bin/router-actions.sh}
IPTABLES_BIN=${CONCIERGE_IPTABLES_BIN:-/usr/sbin/iptables}
SS_BIN=${CONCIERGE_SS_BIN:-/usr/bin/ss}
DEPLOY_SCRIPT="$REPO/bot/scripts/deploy.sh"
DEPLOY_STATE_SCRIPT="$REPO/bot/scripts/deploy-state.ts"
DEPLOY_CONTROL_SCRIPT="$REPO/bot/scripts/deployment-repair/control.ts"
DEPLOY_INTENT_SCRIPT="$REPO/bot/scripts/deployment-intent-request.ts"
DEPLOY_CONTROL_SOCKET_DIR=${CONCIERGE_DEPLOYMENT_SOCKET_DIR:-/run/concierge-deployment}
COORDINATOR_VERSION_PATH=${CONCIERGE_COORDINATOR_VERSION_PATH:-/var/lib/concierge-deploy/runtime-version}
PROVIDER_ADAPTER_VERSION_PATH=${CONCIERGE_PROVIDER_ADAPTER_VERSION_PATH:-/run/concierge-provider-adapter/version}
PROVIDER_RUNTIME_CURRENT=${CONCIERGE_PROVIDER_RUNTIME_CURRENT:-/usr/local/lib/concierge-deployment/provider/current}
DEPLOYMENT_RUNTIME_DIR=${CONCIERGE_DEPLOYMENT_RUNTIME_DIR:-/usr/local/lib/concierge-deployment}
DEPLOY_OWNER_PID=$BASHPID
DEPLOY_RUN_ID=${CONCIERGE_DEPLOY_RUN_ID:-}
DEPLOY_ATTEMPT_ID=${CONCIERGE_DEPLOY_ATTEMPT_ID:-}
DEPLOY_OPERATION_ID=${DEPLOY_ATTEMPT_ID:-${DEPLOY_RUN_ID:-process-$DEPLOY_OWNER_PID}}
DEPLOY_ATTEMPT_STATUS=prepared
DEPLOY_RUN_TERMINAL=0
DEPLOYED_COMMIT=""
DEPLOYED_INVOCATION_ID=""
DEPLOYED_RUNTIME_SHA=""
DEPLOY_RELEASE_ID=""
DEPLOY_RELEASE_STATUS=""
DEPLOY_PRIOR_LKG_ID=""
DEPLOY_PRIOR_LKG_COMMIT=""
DEPLOY_RELEASE_ACTIVATED=0
DEPLOY_INCIDENT_ID=""
ROLLOUT_ID=${CONCIERGE_ROLLOUT_ID:-}
ROLLOUT_DEPLOYMENT_TOKEN=${CONCIERGE_ROLLOUT_DEPLOYMENT_TOKEN:-}
ROLLOUT_CAPTURE_TOKEN=${CONCIERGE_ROLLOUT_CAPTURE_TOKEN:-}
ROLLOUT_GATES_BOUND=0
DEPLOY_ADMISSION_STATE=released
FAILED_CANDIDATE_COMMIT=""
DRAIN_TOKEN=""
CAPTURE_DRAIN_TOKEN=""
CAPTURE_DRAIN_HELD=0
CAPTURE_ADMISSION_BLOCKED=0
PRESERVE_GATES_ON_FAILURE=${CONCIERGE_PRESERVE_GATES_ON_FAILURE:-0}
CAPTURE_BLOCK_COMMENT=concierge-capture-bootstrap-drain
GIT_ORIGIN_VERIFIED=0
CONTROL_PLANE_KERNEL_UNIT_CHANGED=0
CONTROL_PLANE_ADAPTER_UNIT_CHANGED=0
CONTROL_PLANE_COORDINATOR_UNIT_CHANGED=0
CONTROL_PLANE_PROVIDER_UNIT_CHANGED=0
APPLICATION_CUTOVER_STARTED=0
APPLICATION_CUTOVER_COMMITTED=0

resolve_live_state_dir() {
  local environment observed
  if [ -n "${CONCIERGE_STATE_DIR:-}" ]; then
    printf '%s\n' "$CONCIERGE_STATE_DIR"
    return 0
  fi
  set +e
  environment=$(systemctl show "$SERVICE.service" --property=Environment --value 2>/dev/null)
  local systemctl_status=$?
  set -e
  if [ "$systemctl_status" -eq 0 ]; then
    observed=$(printf '%s\n' "$environment" | grep -oE 'CONCIERGE_STATE_DIR=[^ "[:space:]]+' | sed 's/^CONCIERGE_STATE_DIR=//' | tail -n 1 || true)
    if [ -n "$observed" ]; then
      case "$observed" in
        /*) printf '%s\n' "$observed"; return 0 ;;
        *) echo "DEPLOY FAILED: the live service application state directory is not absolute." >&2; return 1 ;;
      esac
    fi
    printf '%s\n' /root/.local/state/concierge
    return 0
  fi
  if [ -e "$APPLICATION_TARGET_STATE_DIR/state.db" ]; then
    echo "DEPLOY FAILED: live service state could not be resolved after containment; refusing the retired root database." >&2
    return 1
  fi
  printf '%s\n' /root/.local/state/concierge
}

bind_live_deployment_paths() {
  STATE_DIR=$(resolve_live_state_dir)
  APPLICATION_SOURCE_STATE_DIR=$STATE_DIR
}

verify_git_origin() {
  [ "$GIT_ORIGIN_VERIFIED" = "0" ] || return 0
  if git ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
    GIT_ORIGIN_VERIFIED=1
    return 0
  fi
  echo "DEPLOY FAILED: Git origin is not readable non-interactively (HOME=$HOME). Configure the existing credential helper for this service account before retrying." >&2
  return 1
}

validate_bootstrap_handoff() {
  local token_file expected_token expected_commit stored_token stored_commit current_commit
  token_file="$STATE_DIR/bootstrap-deploy.token"
  expected_token=${CONCIERGE_BOOTSTRAP_TOKEN:-}
  expected_commit=${CONCIERGE_BOOTSTRAP_UPDATED_COMMIT:-}
  if systemctl is-active --quiet "$SERVICE"; then
    echo "DEPLOY FAILED: bootstrap bypass refused because $SERVICE is still active." >&2
    return 1
  fi
  stored_token=$([ -f "$token_file" ] && sed -n '1p' "$token_file")
  stored_commit=$([ -f "$token_file" ] && sed -n '2p' "$token_file")
  current_commit=$(git rev-parse HEAD 2>/dev/null || true)
  if [ -z "$expected_token" ] || [ -z "$expected_commit" ] || \
    [ "$stored_token" != "$expected_token" ] || [ "$stored_commit" != "$expected_commit" ] || \
    [ "$current_commit" != "$expected_commit" ]; then
    echo "DEPLOY FAILED: bootstrap bypass requires the one-time token and pulled commit proof created after stopping $SERVICE." >&2
    return 1
  fi
  unlink "$token_file"
}

inside_concierge_service() {
  grep -q "${SERVICE}\.service" /proc/self/cgroup 2>/dev/null
}

handoff_from_concierge_service() {
  local unit="concierge-deploy-$(date +%s)-$$"
  bind_live_deployment_paths
  echo "Deploy requested from inside $SERVICE; handing it to transient unit $unit."
  systemd-run \
    --unit "$unit" \
    --collect \
    --no-block \
    --property=Type=exec \
    --setenv=HOME="${HOME:-/root}" \
    --setenv=CONCIERGE_DRAIN_INTERVAL_SECONDS="$DRAIN_INTERVAL_SECONDS" \
    --setenv=CONCIERGE_STATE_DIR="$STATE_DIR" \
    --setenv=CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" \
    --setenv=CONCIERGE_DEPLOY_DETACHED=1 \
    --setenv=CONCIERGE_APPLICATION_CUTOVER_ID="$APPLICATION_CUTOVER_ID" \
    --setenv=CONCIERGE_APPLICATION_CUTOVER_RESUME="$APPLICATION_CUTOVER_RESUME" \
    "$DEPLOY_SCRIPT"
  echo "Deployment is queued outside the bot cgroup. Follow it with: journalctl -fu $unit"
}

request_agent_deployment() {
  local source_repo source_origin target_origin expected_commit output launch_required unit_name control_update_approved
  source_repo=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null) || {
    echo "DEPLOY FAILED: the agent deployment request must run from a Git worktree." >&2
    return 1
  }
  if [ -n "$(git -C "$source_repo" status --porcelain --untracked-files=normal)" ]; then
    echo "DEPLOY FAILED: commit every source-worktree change before requesting deployment." >&2
    return 1
  fi
  source_origin=$(git -C "$source_repo" remote get-url origin 2>/dev/null || true)
  target_origin=$(git -C "$REPO" remote get-url origin 2>/dev/null || true)
  if [ -z "$source_origin" ] || [ "$source_origin" != "$target_origin" ]; then
    echo "DEPLOY FAILED: the source worktree and canonical Concierge checkout must use the same Git origin." >&2
    return 1
  fi
  expected_commit=$(git -C "$source_repo" rev-parse HEAD)
  control_update_approved=0
  [ "${CONCIERGE_APPROVE_CONTROL_PLANE_UPDATE:-0}" = "1" ] && control_update_approved=1
  if [ -n "${CONCIERGE_DEPLOYMENT_INTENT_SOCKET:-}" ]; then
    if ! output=$("$BUN_BIN" run "$DEPLOY_INTENT_SCRIPT" --expected-commit "$expected_commit"); then
      echo "$output" >&2
      return 1
    fi
    echo "$output"
    echo "Deployment intent is durable. The supervisor coordinator will converge it to a healthy release and wake this exact provider session after verification."
    return 0
  fi
  bind_live_deployment_paths
  if [ "$APPLICATION_CUTOVER_RESUME" != "1" ] && \
    [ "${CONCIERGE_ENABLE_CONTROL_REQUESTS:-0}" = "1" ] && [ -S "$DEPLOY_CONTROL_SOCKET_DIR/bot.sock" ]; then
    if ! output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" \
      request --expected-commit "$expected_commit"); then
      echo "$output" >&2
      return 1
    fi
    echo "$output"
    echo "Deployment intent is durable. The supervisor coordinator will converge it to a healthy release and wake this exact provider session after verification."
    return 0
  fi
  if ! output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" \
    request --expected-commit "$expected_commit"); then
    echo "$output" >&2
    return 1
  fi
  echo "$output"
  DEPLOY_RUN_ID=$(printf '%s\n' "$output" | jq -er '.run_id')
  launch_required=$(printf '%s\n' "$output" | jq -r '.launch_required')
  if [ "$launch_required" != "true" ] && [ "$launch_required" != "false" ]; then
    echo "DEPLOY FAILED: deployment request returned an invalid launch_required value." >&2
    return 1
  fi
  unit_name=$(printf '%s\n' "$output" | jq -er '.unit_name')
  if [ "$launch_required" != "true" ]; then
    echo "Deployment request joined existing batch $DEPLOY_RUN_ID. The original provider session will be woken after verified success."
    return 0
  fi

  echo "Deployment request created batch $DEPLOY_RUN_ID; handing it to transient unit $unit_name."
  if ! systemd-run \
    --unit "$unit_name" \
    --collect \
    --no-block \
    --property=Type=exec \
    --setenv=HOME="${HOME:-/root}" \
    --setenv=CONCIERGE_DRAIN_INTERVAL_SECONDS="$DRAIN_INTERVAL_SECONDS" \
    --setenv=CONCIERGE_STATE_DIR="$STATE_DIR" \
    --setenv=CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" \
    --setenv=CONCIERGE_DEPLOY_DETACHED=1 \
    --setenv=CONCIERGE_DEPLOY_RUN_ID="$DEPLOY_RUN_ID" \
    --setenv=CONCIERGE_APPROVE_CONTROL_PLANE_UPDATE="$control_update_approved" \
    --setenv=CONCIERGE_APPLICATION_CUTOVER_ID="$APPLICATION_CUTOVER_ID" \
    --setenv=CONCIERGE_APPLICATION_CUTOVER_RESUME="$APPLICATION_CUTOVER_RESUME" \
    "$DEPLOY_SCRIPT"; then
    if [ "$(systemctl show "$unit_name.service" --property=LoadState --value 2>/dev/null || true)" != "not-found" ]; then
      echo "Transient unit $unit_name already exists; treating the fixed batch identity as launched."
    else
      CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" fail \
        --run-id "$DEPLOY_RUN_ID" --error "systemd refused to launch transient unit $unit_name"
      return 1
    fi
  fi
  echo "Deployment is queued outside the bot cgroup. Follow it with: journalctl -fu $unit_name"
  echo "The provider session will receive a real verification turn only after the deployment and health gate succeed."
}

claim_deployment_run() {
  if [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" claim-attempt \
      --attempt-id "$DEPLOY_ATTEMPT_ID" --owner-pid "$DEPLOY_OWNER_PID"
    DEPLOY_ATTEMPT_STATUS=draining
    return 0
  fi
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" claim \
    --run-id "$DEPLOY_RUN_ID" --owner-pid "$DEPLOY_OWNER_PID"
}

record_deployment_phase() {
  local phase=$1 detail
  detail=${2:-}
  [ -n "$detail" ] || detail='{}'
  if [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    local kernel_phase=$phase
    [ "$phase" != "restarting" ] || kernel_phase=activating
    "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" phase \
      --attempt-id "$DEPLOY_ATTEMPT_ID" \
      --expected-status "$DEPLOY_ATTEMPT_STATUS" \
      --phase "$kernel_phase" \
      --detail "$detail"
    DEPLOY_ATTEMPT_STATUS=$kernel_phase
    return 0
  fi
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" phase \
    --run-id "$DEPLOY_RUN_ID" --phase "$phase" --detail "$detail"
}

record_deployment_failure() {
  local deploy_status=$1
  if [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    [ "$DEPLOY_RUN_TERMINAL" = "0" ] || return 0
    set +e
    local output
    output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" fail \
      --attempt-id "$DEPLOY_ATTEMPT_ID" \
      --expected-status "$DEPLOY_ATTEMPT_STATUS" \
      --error "Deployment runner exited with status $deploy_status before verified completion." \
      --failure-fingerprint "$DEPLOY_ATTEMPT_STATUS:runner-exit:$deploy_status")
    echo "$output"
    DEPLOY_INCIDENT_ID=$(printf '%s\n' "$output" | jq -r '.incident.id // empty')
    set -e
    DEPLOY_RUN_TERMINAL=1
    return 0
  fi
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  [ "$DEPLOY_RUN_TERMINAL" = "0" ] || return 0
  set +e
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" fail \
    --run-id "$DEPLOY_RUN_ID" \
    --error "Deployment runner exited with status $deploy_status before verified completion."
  set -e
  DEPLOY_RUN_TERMINAL=1
}

record_deployment_success() {
  [ -n "$DEPLOY_RUN_ID" ] || [ -n "$DEPLOY_ATTEMPT_ID" ] || return 0
  local evidence
  evidence=$(jq -cn \
    --arg capture "functional health passed" \
    --arg service "functional health passed" \
    --arg runtime_sha "$DEPLOYED_RUNTIME_SHA" \
    --arg admission "$DEPLOY_ADMISSION_STATE" \
    '{capture_probe:$capture,service_probe:$service,runtime_sha:$runtime_sha,admission_gates:$admission}')
  if [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" succeed \
      --attempt-id "$DEPLOY_ATTEMPT_ID" \
      --deployed-commit "$DEPLOYED_COMMIT" \
      --service-invocation-id "$DEPLOYED_INVOCATION_ID" \
      --evidence "$evidence"
  else
    CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" succeed \
      --run-id "$DEPLOY_RUN_ID" \
      --repo "$REPO" \
      --deployed-commit "$DEPLOYED_COMMIT" \
      --service-invocation-id "$DEPLOYED_INVOCATION_ID" \
      --evidence "$evidence"
  fi
  DEPLOY_RUN_TERMINAL=1
}

record_deployment_ambiguity() {
  local error=$1
  if [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    [ "$DEPLOY_RUN_TERMINAL" = "0" ] || return 0
    "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" fail \
      --attempt-id "$DEPLOY_ATTEMPT_ID" \
      --expected-status "$DEPLOY_ATTEMPT_STATUS" \
      --outcome ambiguous \
      --error "$error" \
      --failure-fingerprint "$DEPLOY_ATTEMPT_STATUS:ambiguous"
    DEPLOY_RUN_TERMINAL=1
    return 0
  fi
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  [ "$DEPLOY_RUN_TERMINAL" = "0" ] || return 0
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" fail \
    --run-id "$DEPLOY_RUN_ID" \
    --outcome ambiguous \
    --error "$error"
  DEPLOY_RUN_TERMINAL=1
}

prepare_capture_identity() {
  install -d -m 0755 "$SYSUSERS_DIR"
  install -m 0644 "$REPO/systemd/concierge-capture.conf" "$SYSUSERS_DIR/concierge-capture.conf"
  systemd-sysusers "$SYSUSERS_DIR/concierge-capture.conf"
  install -d -o "$CAPTURE_USER" -g "$CAPTURE_USER" -m 0700 "$CAPTURE_STATE_DIR" "$CAPTURE_AUDIO_DIR"
}

wait_for_drain_recheck() {
  local wait_status=0
  sleep "$DRAIN_INTERVAL_SECONDS" || wait_status=$?
  if [ "$wait_status" -eq 0 ] || [ "$wait_status" -ge 128 ]; then
    return 0
  fi
  return "$wait_status"
}

claim_capture_gate() {
  local output status
  [ -z "$CAPTURE_DRAIN_TOKEN" ] || return 0
  while true; do
    set +e
    output=$(CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" "$BUN_BIN" run "$REPO/bot/scripts/capture-drain-status.ts" claim --owner-pid "$DEPLOY_OWNER_PID" --adopt-held)
    status=$?
    set -e
    echo "$output"
    case "$status" in
      0)
        CAPTURE_DRAIN_TOKEN=$(printf '%s\n' "$output" | jq -er '.token') || {
          echo "DEPLOY FAILED: capture drain claim succeeded without a readable token." >&2
          return 1
        }
        echo "Capture delivery gate claimed. New webhooks will queue until deploy finishes."
        return 0
        ;;
      10)
        echo "A capture is being delivered; deployment will check again in $DRAIN_INTERVAL_SECONDS seconds."
        wait_for_drain_recheck
        ;;
      *)
        echo "DEPLOY FAILED: capture delivery ownership could not be determined safely (exit $status)." >&2
        return 1
        ;;
    esac
  done
}

hold_capture_gate() {
  [ -n "$CAPTURE_DRAIN_TOKEN" ] || {
    echo "DEPLOY FAILED: cannot hold an unclaimed capture gate." >&2
    return 1
  }
  CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" "$BUN_BIN" run \
    "$REPO/bot/scripts/capture-drain-status.ts" hold "$CAPTURE_DRAIN_TOKEN"
  CAPTURE_DRAIN_HELD=1
  echo "Capture delivery gate is durably held until Concierge passes functional health."
}

release_capture_gate() {
  local force=${1:-} status
  [ -n "$CAPTURE_DRAIN_TOKEN" ] || return 0
  if [ "$CAPTURE_DRAIN_HELD" = "1" ] && [ "$force" != "force" ]; then
    echo "Capture delivery remains durably held because Concierge did not pass functional health." >&2
    return 0
  fi
  set +e
  CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" "$BUN_BIN" run \
    "$REPO/bot/scripts/capture-drain-status.ts" \
    "$([ "$force" = "force" ] && printf release || printf release-live)" \
    "$CAPTURE_DRAIN_TOKEN"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "WARNING: failed to release capture gate $CAPTURE_DRAIN_TOKEN; the service will reclaim it after this process exits." >&2
    return "$status"
  fi
  CAPTURE_DRAIN_TOKEN=""
  CAPTURE_DRAIN_HELD=0
}

claim_deployment_gate() {
  local output status
  if [ -n "$ROLLOUT_ID" ] || [ -n "$ROLLOUT_DEPLOYMENT_TOKEN" ] || [ -n "$ROLLOUT_CAPTURE_TOKEN" ]; then
    [ -n "$ROLLOUT_ID" ] && [ -n "$ROLLOUT_DEPLOYMENT_TOKEN" ] && [ -n "$ROLLOUT_CAPTURE_TOKEN" ] || {
      echo "DEPLOY FAILED: incomplete rollout gate authority." >&2
      return 1
    }
    CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$REPO/bot/scripts/drain-status.ts" \
      verify-held "$ROLLOUT_DEPLOYMENT_TOKEN"
    CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" "$BUN_BIN" run \
      "$REPO/bot/scripts/capture-drain-status.ts" verify-held "$ROLLOUT_CAPTURE_TOKEN"
    DRAIN_TOKEN=$ROLLOUT_DEPLOYMENT_TOKEN
    CAPTURE_DRAIN_TOKEN=$ROLLOUT_CAPTURE_TOKEN
    CAPTURE_DRAIN_HELD=1
    ROLLOUT_GATES_BOUND=1
    DEPLOY_ADMISSION_STATE=held
    echo "Exact kernel-owned rollout admission gates verified and retained."
    return 0
  fi
  [ -z "$DRAIN_TOKEN" ] || return 0
  claim_capture_gate
  while true; do
    set +e
    output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$REPO/bot/scripts/drain-status.ts" claim --owner-pid "$DEPLOY_OWNER_PID")
    status=$?
    set -e
    echo "$output"

    case "$status" in
      0)
        DRAIN_TOKEN=$(printf '%s\n' "$output" | jq -er '.token') || {
          echo "DEPLOY FAILED: drain claim succeeded without a readable token." >&2
          return 1
        }
        echo "Deployment gate claimed. New provider turns will wait until deploy finishes."
        return 0
        ;;
      10)
        echo "Active provider work is still running; deployment will check again in $DRAIN_INTERVAL_SECONDS seconds."
        wait_for_drain_recheck
        ;;
      *)
        echo "DEPLOY FAILED: turn ownership could not be determined safely (drain-status exit $status)." >&2
        release_capture_gate || true
        return 1
        ;;
    esac
  done
}

resume_application_cutover_gates() {
  local journal phase output
  [ "$APPLICATION_CUTOVER_RESUME" = "1" ] || return 0
  [ -n "$APPLICATION_CUTOVER_ID" ] || {
    echo "DEPLOY FAILED: application cutover resume requires CONCIERGE_APPLICATION_CUTOVER_ID." >&2
    return 1
  }
  export CONCIERGE_APPLICATION_SOURCE_STATE_DIR="$APPLICATION_SOURCE_STATE_DIR"
  export CONCIERGE_APPLICATION_TARGET_STATE_DIR="$APPLICATION_TARGET_STATE_DIR"
  export CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR"
  export CONCIERGE_SYSTEMD_DIR="$SYSTEMD_DIR"
  journal=$("$BUN_BIN" run "$APPLICATION_CUTOVER_SCRIPT" status --id "$APPLICATION_CUTOVER_ID")
  phase=$(printf '%s\n' "$journal" | jq -er '.phase')
  if [ "$phase" != "parked" ]; then
    echo "DEPLOY FAILED: application cutover $APPLICATION_CUTOVER_ID cannot resume from phase $phase." >&2
    return 1
  fi
  DRAIN_TOKEN=$(printf '%s\n' "$journal" | jq -er '.drain_token')
  CAPTURE_DRAIN_TOKEN=$(printf '%s\n' "$journal" | jq -er '.capture_token')

  output=$(CONCIERGE_STATE_DIR="$APPLICATION_SOURCE_STATE_DIR" "$BUN_BIN" run \
    "$REPO/bot/scripts/drain-status.ts" resume-held "$DRAIN_TOKEN" --owner-pid "$DEPLOY_OWNER_PID")
  echo "$output"
  output=$(CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" "$BUN_BIN" run \
    "$REPO/bot/scripts/capture-drain-status.ts" resume-held "$CAPTURE_DRAIN_TOKEN" --owner-pid "$DEPLOY_OWNER_PID")
  echo "$output"
  CONCIERGE_STATE_DIR="$APPLICATION_SOURCE_STATE_DIR" "$BUN_BIN" run \
    "$REPO/bot/scripts/drain-status.ts" verify-held "$DRAIN_TOKEN"
  CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" "$BUN_BIN" run \
    "$REPO/bot/scripts/capture-drain-status.ts" verify-held "$CAPTURE_DRAIN_TOKEN"
  CAPTURE_DRAIN_HELD=1
  DEPLOY_ADMISSION_STATE=held
  echo "Exact parked application-cutover admission gates reacquired without rotating their tokens."
}

release_turn_gate() {
  local status=0
  [ "$ROLLOUT_GATES_BOUND" = "0" ] || return 0
  if [ -n "$DRAIN_TOKEN" ]; then
    set +e
    CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$REPO/bot/scripts/drain-status.ts" release "$DRAIN_TOKEN"
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
      echo "WARNING: failed to release deployment gate token $DRAIN_TOKEN; startup recovery will clear it once this process exits." >&2
    else
      DRAIN_TOKEN=""
    fi
  fi
  return "$status"
}

release_deployment_gate() {
  local status=0
  [ "$ROLLOUT_GATES_BOUND" = "0" ] || return 0
  release_turn_gate || status=$?
  release_capture_gate force || status=$?
  return "$status"
}

cleanup_failed_deployment() {
  local deploy_status=$?
  record_deployment_failure "$deploy_status" || true
  if [ "$APPLICATION_CUTOVER_STARTED" = "1" ] && [ "$APPLICATION_CUTOVER_COMMITTED" = "0" ]; then
    set +e
    if ! rollback_application_cutover start; then
      systemctl stop "$SERVICE" || true
      set -e
      echo "DEPLOY FAILED during application containment and rollback was not proven. $SERVICE is stopped and admission gates remain held." >&2
      return "$deploy_status"
    fi
    set -e
    if [ "$DEPLOY_RELEASE_ACTIVATED" != "1" ]; then
      local saved_run_id=$DEPLOY_RUN_ID saved_attempt_id=$DEPLOY_ATTEMPT_ID
      DEPLOY_RUN_ID=""
      DEPLOY_ATTEMPT_ID=""
      if ! probe_capture_ingress || ! probe_service; then
        PRESERVE_GATES_ON_FAILURE=1
        systemctl stop "$SERVICE" || true
      fi
      DEPLOY_RUN_ID=$saved_run_id
      DEPLOY_ATTEMPT_ID=$saved_attempt_id
    fi
  fi
  if [ "$DEPLOY_RELEASE_ACTIVATED" = "1" ]; then
    set +e
    if restore_prior_runtime; then
      release_deployment_gate || true
      notify_restored_runtime || echo "WARNING: restored runtime is healthy, but its deterministic Slack incident alert did not settle." >&2
      set -e
      return "$deploy_status"
    fi
    systemctl stop "$SERVICE" || true
    set -e
    echo "DEPLOY FAILED after candidate activation and no healthy runtime restoration was proven. $SERVICE is stopped and admission gates remain held." >&2
    return "$deploy_status"
  fi
  if [ "$PRESERVE_GATES_ON_FAILURE" = "1" ]; then
    echo "DEPLOY FAILED during a coordinated cutover. Admission gates remain held and $SERVICE must stay stopped until the documented recovery is completed." >&2
    echo "Turn gate token: $DRAIN_TOKEN" >&2
    echo "Capture gate token: $CAPTURE_DRAIN_TOKEN" >&2
    return "$deploy_status"
  fi
  unblock_capture_admission || true
  release_turn_gate || true
  release_capture_gate || true
  return "$deploy_status"
}

block_new_capture_connections() {
  if ! "$IPTABLES_BIN" -w -C OUTPUT -p tcp -d 127.0.0.1 --dport 8080 \
    -m conntrack --ctstate NEW -m comment --comment "$CAPTURE_BLOCK_COMMENT" -j REJECT 2>/dev/null; then
    "$IPTABLES_BIN" -w -I OUTPUT -p tcp -d 127.0.0.1 --dport 8080 \
      -m conntrack --ctstate NEW -m comment --comment "$CAPTURE_BLOCK_COMMENT" -j REJECT
  fi
  CAPTURE_ADMISSION_BLOCKED=1
  echo "New capture connections are blocked while the legacy receiver drains."
}

wait_for_capture_connections() {
  while "$SS_BIN" -Htn state established '( sport = :8080 or dport = :8080 )' | grep -q .; do
    echo "An existing capture upload is still active; checking again in $DRAIN_INTERVAL_SECONDS seconds."
    wait_for_drain_recheck
  done
}

unblock_capture_admission() {
  [ "$CAPTURE_ADMISSION_BLOCKED" = "1" ] || return 0
  "$IPTABLES_BIN" -w -D OUTPUT -p tcp -d 127.0.0.1 --dport 8080 \
    -m conntrack --ctstate NEW -m comment --comment "$CAPTURE_BLOCK_COMMENT" -j REJECT
  CAPTURE_ADMISSION_BLOCKED=0
  echo "Capture admission restored."
}

install_systemd_units() {
  local unit src dest
  install -d -m 0755 "$SYSUSERS_DIR"
  install -m 0644 "$REPO/systemd/concierge-deployment.conf" "$SYSUSERS_DIR/concierge-deployment.conf"
  systemd-sysusers "$SYSUSERS_DIR/concierge-deployment.conf"
  install -d -m 0755 "$TMPFILES_DIR"
  install -m 0644 "$REPO/systemd/concierge-deployment.tmpfiles.conf" "$TMPFILES_DIR/concierge-deployment.conf"
  systemd-tmpfiles --create "$TMPFILES_DIR/concierge-deployment.conf"
  for unit in concierge-bot.service agent-inbox.service \
    concierge-deployment-kernel.service concierge-deployment-provider-adapter.service \
    concierge-deployment-repair@.service \
    concierge-deployment-review@.service \
    concierge-deployment-rollout-review@.service \
    concierge-deployment-rollout@.service \
    concierge-deployment-coordinator.service \
    concierge-deployment-coordinator@.service \
    concierge-provider-broker@.socket concierge-provider-broker@.service \
    concierge-provider-worker@.socket concierge-provider-worker@.service; do
    src="$REPO/systemd/$unit"
    dest="$SYSTEMD_DIR/$unit"
    if [ ! -f "$src" ]; then
      echo "DEPLOY FAILED: required systemd source is missing: $src" >&2
      return 1
    fi
    if ! cmp -s "$src" "$dest" 2>/dev/null; then
      cp -a "$src" "$dest"
      echo "  installed $unit"
      case "$unit" in
        concierge-deployment-kernel.service) CONTROL_PLANE_KERNEL_UNIT_CHANGED=1 ;;
        concierge-deployment-provider-adapter.service) CONTROL_PLANE_ADAPTER_UNIT_CHANGED=1 ;;
        concierge-deployment-coordinator.service) CONTROL_PLANE_COORDINATOR_UNIT_CHANGED=1 ;;
        concierge-provider-broker@.socket|concierge-provider-broker@.service|concierge-provider-worker@.socket|concierge-provider-worker@.service) CONTROL_PLANE_PROVIDER_UNIT_CHANGED=1 ;;
      esac
    fi
  done
  chmod +x "$REPO/bot/scripts/healthcheck.ts" 2>/dev/null || true
  chmod +x "$REPO/bot/scripts/capture-healthcheck.ts" 2>/dev/null || true
  chmod +x "$REPO/bot/scripts/install-capture-ingress.ts" 2>/dev/null || true
  chmod +x "$REPO/bot/scripts/capture-drain-status.ts" 2>/dev/null || true
  systemctl daemon-reload
}

install_control_plane_runtime() {
  local output kernel_changed coordinator_changed provider_changed kernel_version coordinator_version coordinator_legacy_version coordinator_candidate_slot provider_version restart_kernel restart_adapter restart_coordinator restart_provider service snapshot running_kernel_version running_adapter_version running_coordinator_version attempt
  output=$("$BUN_BIN" run "$REPO/bot/scripts/deployment-repair/install-control-plane.ts")
  echo "$output"
  kernel_changed=$(printf '%s\n' "$output" | jq -r '.kernel_changed')
  coordinator_changed=$(printf '%s\n' "$output" | jq -r '.coordinator_changed')
  provider_changed=$(printf '%s\n' "$output" | jq -r '.provider_changed')
  kernel_version=$(printf '%s\n' "$output" | jq -er '.kernel_version')
  coordinator_version=$(printf '%s\n' "$output" | jq -er '.coordinator_version')
  coordinator_legacy_version=$(printf '%s\n' "$output" | jq -er '.coordinator_legacy_version // .coordinator_version')
  coordinator_candidate_slot=$(printf '%s\n' "$output" | jq -r '.coordinator_candidate_slot // empty')
  provider_version=$(printf '%s\n' "$output" | jq -er '.provider_version')
  restart_kernel=$CONTROL_PLANE_KERNEL_UNIT_CHANGED
  restart_adapter=$CONTROL_PLANE_ADAPTER_UNIT_CHANGED
  restart_coordinator=$CONTROL_PLANE_COORDINATOR_UNIT_CHANGED
  restart_provider=$CONTROL_PLANE_PROVIDER_UNIT_CHANGED
  [ "$kernel_changed" = "true" ] && restart_kernel=1
  [ "$restart_kernel" = "1" ] && restart_adapter=1
  [ "$provider_changed" = "true" ] && restart_provider=1

  for service in concierge-deployment-kernel.service \
    concierge-deployment-provider-adapter.service \
    concierge-deployment-coordinator.service; do
    systemctl enable "$service" >/dev/null
  done
  if systemctl is-active --quiet concierge-deployment-kernel.service; then
    [ "$restart_kernel" = "1" ] && systemctl restart concierge-deployment-kernel.service
  else
    restart_kernel=1
    systemctl start concierge-deployment-kernel.service
  fi
  if systemctl is-active --quiet concierge-deployment-provider-adapter.service; then
    if [ "$restart_adapter" = "1" ]; then
      unlink "$PROVIDER_ADAPTER_VERSION_PATH" 2>/dev/null || true
      systemctl restart concierge-deployment-provider-adapter.service
    fi
  else
    restart_adapter=1
    unlink "$PROVIDER_ADAPTER_VERSION_PATH" 2>/dev/null || true
    systemctl start concierge-deployment-provider-adapter.service
  fi
  if systemctl is-active --quiet concierge-deployment-coordinator.service; then
    if [ "$restart_coordinator" = "1" ]; then
      unlink "$COORDINATOR_VERSION_PATH" 2>/dev/null || true
      systemctl restart concierge-deployment-coordinator.service
    fi
  else
    restart_coordinator=1
    unlink "$COORDINATOR_VERSION_PATH" 2>/dev/null || true
    systemctl start concierge-deployment-coordinator.service
  fi
  systemctl is-active --quiet concierge-deployment-kernel.service
  systemctl is-active --quiet concierge-deployment-provider-adapter.service
  systemctl is-active --quiet concierge-deployment-coordinator.service
  if [ "$restart_provider" = "1" ]; then
    systemctl try-restart 'concierge-provider-broker@*.service' || true
    systemctl try-restart 'concierge-provider-worker@*.service' || true
  fi
  if [ "$(basename "$(readlink -f "$PROVIDER_RUNTIME_CURRENT")")" != "$provider_version" ]; then
    echo "DEPLOY FAILED: provider broker runtime version does not match the activated bundle." >&2
    return 1
  fi
  if [ "$restart_kernel" = "1" ]; then
    running_kernel_version=""
    for attempt in $(seq 1 10); do
      snapshot=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" snapshot --role operator 2>/dev/null || true)
      running_kernel_version=$(printf '%s\n' "$snapshot" | jq -r '.kernel_runtime_version // empty' 2>/dev/null || true)
      [ "$running_kernel_version" = "$kernel_version" ] && break
      [ "$attempt" -eq 10 ] || sleep 1
    done
    if [ "$running_kernel_version" != "$kernel_version" ]; then
      echo "DEPLOY FAILED: protected kernel runtime version does not match the activated bundle." >&2
      return 1
    fi
  fi
  if [ "$restart_adapter" = "1" ]; then
    running_adapter_version=""
    for attempt in $(seq 1 10); do
      running_adapter_version=$([ -f "$PROVIDER_ADAPTER_VERSION_PATH" ] && sed -n '1p' "$PROVIDER_ADAPTER_VERSION_PATH" || true)
      [ "$running_adapter_version" = "$kernel_version" ] && break
      [ "$attempt" -eq 10 ] || sleep 1
    done
    if [ "$running_adapter_version" != "$kernel_version" ]; then
      echo "DEPLOY FAILED: provider adapter runtime version does not match the activated bundle." >&2
      return 1
    fi
  fi
  if [ "$restart_coordinator" = "1" ]; then
    running_coordinator_version=""
    for attempt in $(seq 1 10); do
      running_coordinator_version=$([ -f "$COORDINATOR_VERSION_PATH" ] && sed -n '1p' "$COORDINATOR_VERSION_PATH" || true)
      [ "$running_coordinator_version" = "$coordinator_legacy_version" ] && break
      [ "$attempt" -eq 10 ] || sleep 1
    done
    if [ "$running_coordinator_version" != "$coordinator_legacy_version" ]; then
      echo "DEPLOY FAILED: incumbent coordinator runtime version does not match its immutable bundle." >&2
      return 1
    fi
  fi
  if [ -n "$coordinator_candidate_slot" ] && \
    [ "$(basename "$(readlink -f "$DEPLOYMENT_RUNTIME_DIR/coordinator/slots/$coordinator_candidate_slot")")" != "$coordinator_version" ]; then
    echo "DEPLOY FAILED: coordinator candidate slot does not match the staged immutable bundle." >&2
    return 1
  fi
}

apply_application_cutover() {
  [ -n "$APPLICATION_CUTOVER_ID" ] || return 0
  [ -n "$DRAIN_TOKEN" ] && [ -n "$CAPTURE_DRAIN_TOKEN" ] || {
    echo "DEPLOY FAILED: application containment cutover requires both exact admission tokens." >&2
    return 1
  }
  APPLICATION_CUTOVER_STARTED=1
  export CONCIERGE_APPLICATION_SOURCE_STATE_DIR="$APPLICATION_SOURCE_STATE_DIR"
  export CONCIERGE_APPLICATION_TARGET_STATE_DIR="$APPLICATION_TARGET_STATE_DIR"
  export CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR"
  export CONCIERGE_SYSTEMD_DIR="$SYSTEMD_DIR"
  echo "=== stop the drained root application before journaled containment cutover ==="
  systemctl stop "$SERVICE"
  "$BUN_BIN" run "$APPLICATION_CUTOVER_SCRIPT" apply \
    --id "$APPLICATION_CUTOVER_ID" \
    --drain-token "$DRAIN_TOKEN" \
    --capture-token "$CAPTURE_DRAIN_TOKEN"
  STATE_DIR=$APPLICATION_TARGET_STATE_DIR
  export CONCIERGE_STATE_DIR="$STATE_DIR"
  export CONCIERGE_PROVIDER_BROKER_ENABLED=1
  export CONCIERGE_PROVIDER_PROJECTS_PATH=/var/lib/concierge-bot/provider-projects.json
  "$BUN_BIN" run "$APPLICATION_CUTOVER_SCRIPT" verify --id "$APPLICATION_CUTOVER_ID"
  runuser -u concierge-bot -- env \
    CONCIERGE_STATE_DIR="$APPLICATION_TARGET_STATE_DIR" \
    CONCIERGE_APPLICATION_TARGET_STATE_DIR="$APPLICATION_TARGET_STATE_DIR" \
    CONCIERGE_PROVIDER_PROJECTS_PATH=/var/lib/concierge-bot/provider-projects.json \
    /usr/local/lib/concierge-deployment/bun \
    /usr/local/lib/concierge-deployment/provider/current/continuity.js
}

commit_application_cutover() {
  [ "$APPLICATION_CUTOVER_STARTED" = "1" ] || return 0
  "$BUN_BIN" run "$APPLICATION_CUTOVER_SCRIPT" verify --id "$APPLICATION_CUTOVER_ID"
  "$BUN_BIN" run "$APPLICATION_CUTOVER_SCRIPT" commit --id "$APPLICATION_CUTOVER_ID"
  APPLICATION_CUTOVER_COMMITTED=1
}

rollback_application_cutover() {
  local start_service=${1:-}
  [ "$APPLICATION_CUTOVER_STARTED" = "1" ] || return 0
  [ "$APPLICATION_CUTOVER_COMMITTED" = "0" ] || return 0
  if [ "$start_service" = "start" ]; then
    "$BUN_BIN" run "$APPLICATION_CUTOVER_SCRIPT" rollback --id "$APPLICATION_CUTOVER_ID" --start-service
  else
    "$BUN_BIN" run "$APPLICATION_CUTOVER_SCRIPT" rollback --id "$APPLICATION_CUTOVER_ID"
  fi
  STATE_DIR=$APPLICATION_SOURCE_STATE_DIR
  export CONCIERGE_STATE_DIR="$STATE_DIR"
  unset CONCIERGE_PROVIDER_BROKER_ENABLED CONCIERGE_PROVIDER_PROJECTS_PATH
  APPLICATION_CUTOVER_STARTED=0
}

verify_deployment_notifier() {
  "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" notifier-bootstrap \
    --registry-code-path "$REPO"
  "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" notifier-preflight \
    --idempotency-key "kernel:notifier.preflight:concierge:v1"
}

prepare_immutable_release() {
  local output
  if [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" prepare-release --attempt-id "$DEPLOY_ATTEMPT_ID")
  else
    output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" bootstrap-release \
      --idempotency-key "kernel:release.bootstrap_prepare:$DEPLOYED_COMMIT:$DEPLOY_OPERATION_ID")
  fi
  echo "$output"
  DEPLOY_RELEASE_ID=$(printf '%s\n' "$output" | jq -er '.release.id')
  DEPLOY_RELEASE_STATUS=$(printf '%s\n' "$output" | jq -er '.release.status')
  DEPLOY_PRIOR_LKG_ID=$(printf '%s\n' "$output" | jq -r '.prior_last_known_good.id // empty')
  DEPLOY_PRIOR_LKG_COMMIT=$(printf '%s\n' "$output" | jq -r '.prior_last_known_good.git_commit // empty')
}

activate_immutable_release() {
  local output
  DEPLOY_RELEASE_ACTIVATED=1
  if [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" activate-release \
      --attempt-id "$DEPLOY_ATTEMPT_ID" --release-id "$DEPLOY_RELEASE_ID")
  else
    output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" bootstrap-activate-release \
      --release-id "$DEPLOY_RELEASE_ID" \
      --expected-status "$DEPLOY_RELEASE_STATUS" \
      --idempotency-key "kernel:release.bootstrap_activate:$DEPLOY_RELEASE_ID:$DEPLOY_RELEASE_STATUS:$DEPLOY_OPERATION_ID")
  fi
  echo "$output"
}

mark_immutable_release_healthy() {
  [ -n "$DEPLOY_ATTEMPT_ID" ] || return 0
  local evidence output
  evidence=$(jq -cn \
    --arg capture "functional health passed" \
    --arg service "functional health passed" \
    --arg runtime_sha "$DEPLOYED_RUNTIME_SHA" \
    --arg invocation "$DEPLOYED_INVOCATION_ID" \
    --arg admission "$DEPLOY_ADMISSION_STATE" \
    '{capture_probe:$capture,service_probe:$service,runtime_sha:$runtime_sha,service_invocation_id:$invocation,admission_gates:$admission}')
  output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" healthy-release \
    --attempt-id "$DEPLOY_ATTEMPT_ID" --release-id "$DEPLOY_RELEASE_ID" \
    --service-invocation-id "$DEPLOYED_INVOCATION_ID" --evidence "$evidence")
  echo "$output"
  DEPLOY_RELEASE_STATUS=healthy
}

promote_immutable_release() {
  if [ "$DEPLOY_RELEASE_STATUS" = "last_known_good" ]; then
    DEPLOY_RELEASE_ACTIVATED=0
    return 0
  fi
  local evidence output
  evidence=$(jq -cn \
    --arg capture "functional health passed" \
    --arg service "functional health passed" \
    --arg runtime_sha "$DEPLOYED_RUNTIME_SHA" \
    --arg invocation "$DEPLOYED_INVOCATION_ID" \
    --arg admission "$DEPLOY_ADMISSION_STATE" \
    '{capture_probe:$capture,service_probe:$service,runtime_sha:$runtime_sha,service_invocation_id:$invocation,admission_gates:$admission}')
  if [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" promote-release \
      --attempt-id "$DEPLOY_ATTEMPT_ID" --release-id "$DEPLOY_RELEASE_ID" --evidence "$evidence")
  else
    output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" bootstrap-promote-release \
      --release-id "$DEPLOY_RELEASE_ID" \
      --expected-status "$DEPLOY_RELEASE_STATUS" \
      --service-invocation-id "$DEPLOYED_INVOCATION_ID" \
      --evidence "$evidence" \
      --idempotency-key "kernel:release.bootstrap_promote:$DEPLOY_RELEASE_ID:$DEPLOYED_INVOCATION_ID:$DEPLOY_OPERATION_ID")
  fi
  echo "$output"
  DEPLOY_RELEASE_STATUS=last_known_good
  DEPLOY_RELEASE_ACTIVATED=0
}

restore_prior_runtime() {
  [ "$DEPLOY_RELEASE_ACTIVATED" = "1" ] || return 1
  local output
  FAILED_CANDIDATE_COMMIT=$DEPLOYED_COMMIT
  if [ -n "$DEPLOY_PRIOR_LKG_ID" ]; then
    if [ -n "$DEPLOY_INCIDENT_ID" ]; then
      "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" incident-transition \
        --incident-id "$DEPLOY_INCIDENT_ID" --expected-status open --status stabilizing \
        --idempotency-key "kernel:incident.stabilizing:$DEPLOY_INCIDENT_ID"
      output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" restore-release \
        --incident-id "$DEPLOY_INCIDENT_ID" --release-id "$DEPLOY_PRIOR_LKG_ID") || return 1
    else
      output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" bootstrap-restore-release \
        --release-id "$DEPLOY_PRIOR_LKG_ID" \
        --idempotency-key "kernel:release.bootstrap_restore:$DEPLOY_RELEASE_ID:$DEPLOY_PRIOR_LKG_ID:$DEPLOY_OPERATION_ID") || return 1
    fi
    DEPLOYED_COMMIT=$DEPLOY_PRIOR_LKG_COMMIT
  else
    output=$("$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" bootstrap-abort-release \
      --idempotency-key "kernel:release.bootstrap_abort:$DEPLOY_RELEASE_ID:$DEPLOY_OPERATION_ID") || return 1
    DEPLOYED_COMMIT=$(git -C "$REPO" rev-parse HEAD)
  fi
  echo "$output"
  DEPLOY_RELEASE_ACTIVATED=0
  probe_capture_ingress
  probe_service
  confirm_service_proof_is_current
  if [ -n "$DEPLOY_INCIDENT_ID" ]; then
    local evidence
    evidence=$(jq -cn \
      --arg capture "functional health passed" \
      --arg service "functional health passed" \
      --arg runtime_sha "$DEPLOYED_RUNTIME_SHA" \
      --arg invocation "$DEPLOYED_INVOCATION_ID" \
      '{capture_probe:$capture,service_probe:$service,runtime_sha:$runtime_sha,service_invocation_id:$invocation,admission_gates:"held"}')
    "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" restore-proven \
      --incident-id "$DEPLOY_INCIDENT_ID" --attempt-id "$DEPLOY_ATTEMPT_ID" \
      --release-id "$DEPLOY_PRIOR_LKG_ID" --service-invocation-id "$DEPLOYED_INVOCATION_ID" \
      --evidence "$evidence"
  fi
  echo "The failed candidate was replaced by the proven prior runtime $DEPLOYED_COMMIT." >&2
}

notify_restored_runtime() {
  [ -n "$DEPLOY_INCIDENT_ID" ] || return 0
  local projection
  projection=$(jq -cn \
    --arg incident "$DEPLOY_INCIDENT_ID" \
    --arg candidate "$FAILED_CANDIDATE_COMMIT" \
    --arg restored "$DEPLOYED_COMMIT" \
    --arg invocation "$DEPLOYED_INVOCATION_ID" \
    '{incident_id:$incident,candidate_commit:$candidate,restored_commit:$restored,service_invocation_id:$invocation,capture_probe:"functional health passed",service_probe:"functional health passed",admission_state:"released",reason_code:"candidate_health_failed"}')
  "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" notification-send \
    --incident-id "$DEPLOY_INCIDENT_ID" --expected-status stabilizing \
    --kind runtime_restored --projection "$projection" \
    --idempotency-key "kernel:notification.runtime_restored:$DEPLOY_INCIDENT_ID"
  "$BUN_BIN" run "$DEPLOY_CONTROL_SCRIPT" incident-transition \
    --incident-id "$DEPLOY_INCIDENT_ID" --expected-status stabilizing --status diagnosing \
    --idempotency-key "kernel:incident.diagnosing:$DEPLOY_INCIDENT_ID"
}

install_router_actions() {
  local source="$REPO/systemd/router-actions.sh"
  if [ ! -f "$source" ]; then
    echo "DEPLOY FAILED: router action source is missing: $source" >&2
    return 1
  fi
  install -d -m 0755 "$(dirname "$ROUTER_ACTIONS_DEST")"
  install -m 0755 "$source" "$ROUTER_ACTIONS_DEST"
}

install_capture_runtime() {
  local bundle_tmp bun_tmp
  install -d -m 0755 "$CAPTURE_RUNTIME_DIR" "$(dirname "$CAPTURE_CONFIG_DEST")"
  bundle_tmp="$CAPTURE_RUNTIME_DIR/.capture-ingress.$$.js"
  bun_tmp="$CAPTURE_RUNTIME_DIR/.bun.$$"
  "$BUN_BIN" build "$REPO/bot/src/capture-ingress.ts" --target bun --outfile "$bundle_tmp"
  install -m 0755 "$(realpath "$BUN_BIN")" "$bun_tmp"
  mv "$bundle_tmp" "$CAPTURE_RUNTIME_DIR/capture-ingress.js"
  mv "$bun_tmp" "$CAPTURE_RUNTIME_DIR/bun"
  chmod 0755 "$CAPTURE_RUNTIME_DIR/capture-ingress.js" "$CAPTURE_RUNTIME_DIR/bun"
  install -m 0644 "$REPO/config/capture-routes.toml" "$CAPTURE_CONFIG_DEST"
}

probe_capture_ingress() {
  local attempt state main_pid
  for attempt in $(seq 1 10); do
    state=$(systemctl is-active agent-inbox.service 2>/dev/null || true)
    main_pid=$(systemctl show agent-inbox.service --property=MainPID --value 2>/dev/null || true)
    if [ "$state" = "active" ] && [ "${main_pid:-0}" -gt 0 ] 2>/dev/null; then
      if "$BUN_BIN" run "$REPO/bot/scripts/capture-healthcheck.ts"; then
        echo "Capture ingress probe passed (state=$state, MainPID=$main_pid, local health=ok)."
        return 0
      fi
    fi
    [ "$attempt" -eq 10 ] || sleep 1
  done
  echo "CAPTURE INGRESS FAILED FUNCTIONAL PROBE. Recent logs:" >&2
  journalctl -u agent-inbox.service --since "2 min ago" --no-pager | tail -50 >&2
  return 1
}

probe_service() {
  local attempt state main_pid invocation_id online runtime_sha
  for attempt in $(seq 1 10); do
    state=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
    main_pid=$(systemctl show "$SERVICE" --property=MainPID --value 2>/dev/null || true)
    invocation_id=$(systemctl show "$SERVICE" --property=InvocationID --value 2>/dev/null || true)
    online=""
    if [ -n "$invocation_id" ]; then
      online=$(journalctl "_SYSTEMD_INVOCATION_ID=$invocation_id" --no-pager 2>/dev/null | grep -m1 "concierge_bot_online" || true)
    fi
    runtime_sha=$(printf '%s\n' "$online" | sed -n 's/.*"git_sha":"\([0-9a-f]\{40\}\)".*/\1/p')
    if [ "$state" = "active" ] && [ "${main_pid:-0}" -gt 0 ] 2>/dev/null; then
      if [ -n "$online" ] && "$BUN_BIN" run "$REPO/bot/scripts/healthcheck.ts"; then
        if { [ -n "$DEPLOY_RUN_ID" ] || [ -n "$DEPLOY_ATTEMPT_ID" ]; } && [ "$runtime_sha" != "$DEPLOYED_COMMIT" ]; then
          echo "SERVICE PROVENANCE PROBE FAILED: runtime reported ${runtime_sha:-no SHA}, expected $DEPLOYED_COMMIT." >&2
          return 1
        fi
        DEPLOYED_INVOCATION_ID=$invocation_id
        DEPLOYED_RUNTIME_SHA=$runtime_sha
        echo "Service probe passed (state=$state, MainPID=$main_pid, InvocationID=$invocation_id, runtime SHA=${runtime_sha:-unreported}, Slack and Codex App Server probes=ok)."
        return 0
      fi
    fi
    [ "$attempt" -eq 10 ] || sleep 3
  done

  echo "SERVICE FAILED FUNCTIONAL PROBE. Recent logs:" >&2
  journalctl -u "$SERVICE" --since "2 min ago" --no-pager | tail -50 >&2
  return 1
}

confirm_service_proof_is_current() {
  local proven_invocation_id=$DEPLOYED_INVOCATION_ID
  local proven_runtime_sha=$DEPLOYED_RUNTIME_SHA
  if ! probe_service; then
    record_deployment_ambiguity \
      "The service could not be re-proven healthy immediately before deployment success."
    return 1
  fi
  if [ "$DEPLOYED_INVOCATION_ID" != "$proven_invocation_id" ] || \
    [ "$DEPLOYED_RUNTIME_SHA" != "$proven_runtime_sha" ]; then
    record_deployment_ambiguity \
      "The service invocation or runtime commit changed after the deployment health gate; the deployed outcome is ambiguous."
    return 1
  fi
}

deploy() {
  bind_live_deployment_paths
  cd "$REPO"
  if [ -n "$DEPLOY_RUN_ID" ] || [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    claim_deployment_run
    trap cleanup_failed_deployment EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
  fi
  if [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" = "1" ]; then
    validate_bootstrap_handoff
    DEPLOYED_COMMIT=$(git rev-parse HEAD)
  else
    verify_git_origin
  fi
  prepare_capture_identity

  if [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" = "1" ]; then
    claim_capture_gate
    hold_capture_gate
    trap cleanup_failed_deployment EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    echo "=== first-rollout bootstrap: service already stopped; admission is closed ==="
  else
    echo "=== atomically drain active provider turns ==="
    if [ "$APPLICATION_CUTOVER_RESUME" = "1" ]; then
      resume_application_cutover_gates
    else
      claim_deployment_gate
    fi
    [ -n "$DEPLOY_RUN_ID" ] || [ -n "$DEPLOY_ATTEMPT_ID" ] || trap cleanup_failed_deployment EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    record_deployment_phase updating "{\"gate\":\"claimed\"}"
    echo "=== git pull --rebase origin main ==="
    git fetch origin
    if ! git pull --rebase origin main; then
      echo "DEPLOY FAILED: git pull could not rebase cleanly. Fix it in git; never copy files around git." >&2
      return 1
    fi
    DEPLOYED_COMMIT=$(git rev-parse HEAD)
  fi

  echo "=== install frozen production dependencies ==="
  (cd "$REPO/bot" && "$BUN_BIN" install --backend=copyfile --frozen-lockfile --production)

  chown -R "$CAPTURE_USER:$CAPTURE_USER" "$CAPTURE_STATE_DIR"

  echo "=== install/refresh systemd units ==="
  install_systemd_units

  echo "=== install/verify protected deployment control plane ==="
  install_control_plane_runtime

  echo "=== verify deterministic deployment incident notifier ==="
  verify_deployment_notifier

  echo "=== build and verify immutable application release ==="
  prepare_immutable_release

  echo "=== install router action helper ==="
  install_router_actions

  echo "=== install capture ingress runtime and route config ==="
  install_capture_runtime

  echo "=== install/verify capture ingress secrets ==="
  "$BUN_BIN" run "$REPO/bot/scripts/install-capture-ingress.ts"

  echo "=== install/verify local audio transcriber ==="
  if [ -x "$REPO/bot/scripts/install-transcriber.sh" ]; then
    "$REPO/bot/scripts/install-transcriber.sh"
  fi

  record_deployment_phase restarting "{\"deployed_commit\":\"$DEPLOYED_COMMIT\"}"
  echo "=== gracefully replace $CAPTURE_SERVICE ==="
  systemctl enable "$CAPTURE_SERVICE" >/dev/null
  if [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" = "1" ]; then
    block_new_capture_connections
    wait_for_capture_connections
    systemctl stop "$CAPTURE_SERVICE"
    systemctl start "$CAPTURE_SERVICE"
    unblock_capture_admission
  else
    systemctl restart "$CAPTURE_SERVICE"
  fi
  probe_capture_ingress

  if [ "$CAPTURE_DRAIN_HELD" != "1" ]; then
    hold_capture_gate
  fi

  apply_application_cutover

  echo "=== activate immutable application release ==="
  activate_immutable_release
  record_deployment_phase verifying "{\"deployed_commit\":\"$DEPLOYED_COMMIT\"}"
  probe_service
  mark_immutable_release_healthy
  commit_application_cutover

  if [ -n "$DRAIN_TOKEN" ] || [ -n "$CAPTURE_DRAIN_TOKEN" ]; then
    record_deployment_phase releasing "{\"service_invocation_id\":\"$DEPLOYED_INVOCATION_ID\"}"
    release_deployment_gate
  fi

  if [ -n "$DEPLOY_RUN_ID" ] || [ -n "$DEPLOY_ATTEMPT_ID" ]; then
    confirm_service_proof_is_current
    promote_immutable_release
    record_deployment_success
  else
    confirm_service_proof_is_current
    promote_immutable_release
  fi
  trap - EXIT INT TERM

  echo "=== deploy complete ==="
  git log -1 --oneline
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ -n "${CONCIERGE_TURN_ID:-}" ] && [ "${CONCIERGE_DEPLOY_DETACHED:-0}" != "1" ]; then
    request_agent_deployment
    exit 0
  fi
  if [ "${CONCIERGE_DEPLOY_DETACHED:-0}" != "1" ] && inside_concierge_service; then
    handoff_from_concierge_service
    exit 0
  fi
  deploy
fi
