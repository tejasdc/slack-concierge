#!/usr/bin/env bash
# Concierge deploy — the only supported path to update the service peer.

set -euo pipefail

export HOME=${HOME:-/root}
export GIT_TERMINAL_PROMPT=0

REPO=${CONCIERGE_REPO:-/root/workspace/slack-concierge}
SERVICE=${CONCIERGE_SERVICE:-concierge-bot}
STATE_DIR=${CONCIERGE_STATE_DIR:-/root/.local/state/concierge}
CAPTURE_SERVICE=${CONCIERGE_CAPTURE_SERVICE:-agent-inbox.service}
CAPTURE_STATE_DIR=${CONCIERGE_CAPTURE_STATE_DIR:-/var/lib/concierge-capture}
CAPTURE_AUDIO_DIR=${CONCIERGE_CAPTURE_AUDIO_DIR:-/var/agent-inbox}
CAPTURE_USER=${CONCIERGE_CAPTURE_USER:-concierge-capture}
CAPTURE_RUNTIME_DIR=${CONCIERGE_CAPTURE_RUNTIME_DIR:-/usr/local/lib/slack-concierge}
CAPTURE_CONFIG_DEST=${CONCIERGE_CAPTURE_CONFIG_DEST:-/etc/concierge/capture-routes.toml}
SYSUSERS_DIR=${CONCIERGE_SYSUSERS_DIR:-/etc/sysusers.d}
BUN_BIN=${CONCIERGE_BUN_BIN:-/root/.bun/bin/bun}
DRAIN_INTERVAL_SECONDS=${CONCIERGE_DRAIN_INTERVAL_SECONDS:-1200}
SYSTEMD_DIR=${CONCIERGE_SYSTEMD_DIR:-/etc/systemd/system}
ROUTER_ACTIONS_DEST=${CONCIERGE_ROUTER_ACTIONS_DEST:-/root/.local/bin/router-actions.sh}
IPTABLES_BIN=${CONCIERGE_IPTABLES_BIN:-/usr/sbin/iptables}
SS_BIN=${CONCIERGE_SS_BIN:-/usr/bin/ss}
CONTROL_DIR=${CONCIERGE_DEPLOYMENT_CONTROL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
CONTROL_SYSTEMD_DIR="$CONTROL_DIR/systemd"
CONTROL_CONFIG_DIR="$CONTROL_DIR/config"
if [ -f "$CONTROL_DIR/deploy-state.js" ]; then
  DEPLOY_STATE_SCRIPT="$CONTROL_DIR/deploy-state.js"
  RELEASE_MANAGER_SCRIPT="$CONTROL_DIR/release-manager.js"
  MIGRATION_SCRIPT="$CONTROL_DIR/migrate-deployment-repair.js"
  DRAIN_STATUS_SCRIPT="$CONTROL_DIR/drain-status.js"
  CAPTURE_DRAIN_STATUS_SCRIPT="$CONTROL_DIR/capture-drain-status.js"
  HEALTHCHECK_SCRIPT="$CONTROL_DIR/healthcheck.js"
  CAPTURE_HEALTHCHECK_SCRIPT="$CONTROL_DIR/capture-healthcheck.js"
  CAPTURE_INSTALL_SCRIPT="$CONTROL_DIR/install-capture-ingress.js"
else
  CONTROL_SYSTEMD_DIR="$REPO/systemd"
  CONTROL_CONFIG_DIR="$REPO/config"
  DEPLOY_STATE_SCRIPT="$CONTROL_DIR/deploy-state.ts"
  RELEASE_MANAGER_SCRIPT="$CONTROL_DIR/release-manager.ts"
  MIGRATION_SCRIPT="$CONTROL_DIR/migrate-deployment-repair.ts"
  DRAIN_STATUS_SCRIPT="$CONTROL_DIR/drain-status.ts"
  CAPTURE_DRAIN_STATUS_SCRIPT="$CONTROL_DIR/capture-drain-status.ts"
  HEALTHCHECK_SCRIPT="$CONTROL_DIR/healthcheck.ts"
  CAPTURE_HEALTHCHECK_SCRIPT="$CONTROL_DIR/capture-healthcheck.ts"
  CAPTURE_INSTALL_SCRIPT="$CONTROL_DIR/install-capture-ingress.ts"
fi
DEPLOY_CONTROL_COMMAND=${CONCIERGE_DEPLOY_COMMAND:-/usr/local/lib/slack-concierge-deployment/control}
DEPLOY_COMMAND=("$REPO/bot/scripts/deploy.sh")
if [ -x "$DEPLOY_CONTROL_COMMAND" ]; then DEPLOY_COMMAND=("$DEPLOY_CONTROL_COMMAND" deploy); fi
DEPLOY_OWNER_PID=$BASHPID
DEPLOY_RUN_ID=${CONCIERGE_DEPLOY_RUN_ID:-}
DEPLOY_RUN_TERMINAL=0
DEPLOYED_COMMIT=""
FAILED_CANDIDATE_COMMIT=""
DEPLOYED_INVOCATION_ID=""
DEPLOYED_RUNTIME_SHA=""
CANDIDATE_ARTIFACT_PATH=""
CANDIDATE_ARTIFACT_DIGEST=""
DRAIN_TOKEN=""
CAPTURE_DRAIN_TOKEN=""
CAPTURE_DRAIN_HELD=0
CAPTURE_ADMISSION_BLOCKED=0
PRESERVE_GATES_ON_FAILURE=${CONCIERGE_PRESERVE_GATES_ON_FAILURE:-0}
CAPTURE_BLOCK_COMMENT=concierge-capture-bootstrap-drain
GIT_ORIGIN_VERIFIED=0
MIGRATION_DONE=0
CURRENT_DEPLOY_STAGE=starting
LAST_FAILED_COMMAND=unknown
LAST_FAILURE_LINE=0
DEPLOY_FAILURE_REASON="The deployment runner stopped before the current operation reported a result."
INTERRUPTED_RECOVERY_HANDLED=0

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
  echo "Deploy requested from inside $SERVICE; handing it to transient unit $unit."
  systemd-run \
    --unit "$unit" \
    --collect \
    --no-block \
    --property=Type=exec \
    --property=Restart=on-failure \
    --property=RestartSec=10 \
    --setenv=HOME="${HOME:-/root}" \
    --setenv=CONCIERGE_DRAIN_INTERVAL_SECONDS="$DRAIN_INTERVAL_SECONDS" \
    --setenv=CONCIERGE_DEPLOY_DETACHED=1 \
    "${DEPLOY_COMMAND[@]}"
  echo "Deployment is queued outside the bot cgroup. Follow it with: journalctl -fu $unit"
}

request_agent_deployment() {
  local source_repo source_origin target_origin expected_commit output launch_required unit_name
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
    --property=Restart=on-failure \
    --property=RestartSec=10 \
    --setenv=HOME="${HOME:-/root}" \
    --setenv=CONCIERGE_DRAIN_INTERVAL_SECONDS="$DRAIN_INTERVAL_SECONDS" \
    --setenv=CONCIERGE_DEPLOY_DETACHED=1 \
    --setenv=CONCIERGE_DEPLOY_RUN_ID="$DEPLOY_RUN_ID" \
    "${DEPLOY_COMMAND[@]}"; then
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
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" claim \
    --run-id "$DEPLOY_RUN_ID" --owner-pid "$DEPLOY_OWNER_PID"
}

record_deployment_phase() {
  local phase=$1 detail
  detail=${2:-}
  [ -n "$detail" ] || detail='{}'
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" phase \
    --run-id "$DEPLOY_RUN_ID" --phase "$phase" --detail "$detail"
}

deployment_stage_label() {
  case "$1" in
    starting) printf 'Deployment startup' ;;
    run-claim) printf 'Durable run claim' ;;
    origin-verification) printf 'Git origin verification' ;;
    state-migration) printf 'Deployment state migration' ;;
    admission-drain) printf 'Active-work drain' ;;
    git-update) printf 'Git update' ;;
    dependency-install) printf 'Production dependency installation' ;;
    runtime-install) printf 'Runtime installation' ;;
    candidate-activation) printf 'Candidate release activation' ;;
    capture-runtime-install) printf 'Capture ingress installation' ;;
    capture-restart-and-health) printf 'Capture ingress restart and health verification' ;;
    candidate-restart-and-health) printf 'Candidate restart and health verification' ;;
    repair-cutover) printf 'Trusted-root repair cutover' ;;
    interrupted-*) printf 'Interrupted candidate recovery' ;;
    *) printf 'Deployment stage %s' "$1" ;;
  esac
}

record_deployment_failure() {
  local deploy_status=$1 error stage_label
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  [ "$DEPLOY_RUN_TERMINAL" = "0" ] || return 0
  stage_label=$(deployment_stage_label "$CURRENT_DEPLOY_STAGE")
  error="$stage_label failed: $DEPLOY_FAILURE_REASON"
  set +e
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" fail \
    --run-id "$DEPLOY_RUN_ID" \
    --error "$error" \
    --stage "$CURRENT_DEPLOY_STAGE" \
    --failed-command "$LAST_FAILED_COMMAND" \
    --failure-line "$LAST_FAILURE_LINE" \
    --exit-status "$deploy_status"
  set -e
  DEPLOY_RUN_TERMINAL=1
}

record_deployment_success() {
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  local evidence
  evidence=$(jq -cn \
    --arg capture "functional health passed" \
    --arg service "functional health passed" \
    --arg runtime_sha "$DEPLOYED_RUNTIME_SHA" \
    --arg release_digest "$CANDIDATE_ARTIFACT_DIGEST" \
    '{capture_probe:$capture,service_probe:$service,runtime_sha:$runtime_sha,release_digest:$release_digest,admission_gates:"released"}')
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" succeed \
    --run-id "$DEPLOY_RUN_ID" \
    --repo "$REPO" \
    --deployed-commit "$DEPLOYED_COMMIT" \
    --service-invocation-id "$DEPLOYED_INVOCATION_ID" \
    --evidence "$evidence"
  DEPLOY_RUN_TERMINAL=1
}

record_deployment_ambiguity() {
  local error=$1 notice_reason=${2:-$1} exit_status=${3:-}
  local failed_command=${4:-$LAST_FAILED_COMMAND} failure_line=${5:-$LAST_FAILURE_LINE}
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  [ "$DEPLOY_RUN_TERMINAL" = "0" ] || return 0
  local arguments=( \
    --run-id "$DEPLOY_RUN_ID" \
    --outcome ambiguous \
    --error "$error" \
    --notice-reason "$notice_reason" \
    --stage "$CURRENT_DEPLOY_STAGE" \
  )
  if [ -n "$failed_command" ] && [ "$failed_command" != "unknown" ]; then
    arguments+=(--failed-command "$failed_command")
  fi
  if [ "$failure_line" -gt 0 ] 2>/dev/null; then arguments+=(--failure-line "$failure_line"); fi
  if [ -n "$exit_status" ]; then arguments+=(--exit-status "$exit_status"); fi
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" fail "${arguments[@]}"
  DEPLOY_RUN_TERMINAL=1
}

prepare_capture_identity() {
  install -d -m 0755 "$SYSUSERS_DIR"
  install -m 0644 "$CONTROL_SYSTEMD_DIR/concierge-capture.conf" "$SYSUSERS_DIR/concierge-capture.conf"
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
    output=$(CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" "$BUN_BIN" run "$CAPTURE_DRAIN_STATUS_SCRIPT" claim --owner-pid "$DEPLOY_OWNER_PID" --adopt-held)
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
    "$CAPTURE_DRAIN_STATUS_SCRIPT" hold "$CAPTURE_DRAIN_TOKEN"
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
    "$CAPTURE_DRAIN_STATUS_SCRIPT" \
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
  [ -z "$DRAIN_TOKEN" ] || return 0
  claim_capture_gate
  while true; do
    set +e
    output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DRAIN_STATUS_SCRIPT" claim --owner-pid "$DEPLOY_OWNER_PID")
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

release_turn_gate() {
  local status=0
  if [ -n "$DRAIN_TOKEN" ]; then
    set +e
    CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DRAIN_STATUS_SCRIPT" release "$DRAIN_TOKEN"
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
  release_turn_gate || status=$?
  release_capture_gate force || status=$?
  return "$status"
}

recover_abandoned_gates() {
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DRAIN_STATUS_SCRIPT" recover
  CONCIERGE_CAPTURE_STATE_DIR="$CAPTURE_STATE_DIR" "$BUN_BIN" run "$CAPTURE_DRAIN_STATUS_SCRIPT" recover
}

cleanup_failed_deployment() {
  local deploy_status=$?
  if [ "$PRESERVE_GATES_ON_FAILURE" = "1" ]; then
    record_deployment_failure "$deploy_status" || true
    echo "DEPLOY FAILED during the project-scaffold cutover. Admission gates remain held and $SERVICE must stay stopped until the documented recovery is completed." >&2
    echo "Turn gate token: $DRAIN_TOKEN" >&2
    echo "Capture gate token: $CAPTURE_DRAIN_TOKEN" >&2
    return "$deploy_status"
  fi
  if [ -n "$DEPLOY_RUN_ID" ] && [ "$DEPLOY_RUN_TERMINAL" = "0" ] && \
    handoff_failed_deployment_to_repair "$deploy_status"; then
    echo "Deployment failure was handed to autonomous trusted-root repair." >&2
    trap - EXIT ERR INT TERM
    exit 0
  fi
  record_deployment_failure "$deploy_status" || true
  unblock_capture_admission || true
  release_turn_gate || true
  release_capture_gate || true
  return "$deploy_status"
}

handoff_failed_deployment_to_repair() {
  local deploy_status=$1 lkg_output failed_commit restored_commit failure_error fingerprint
  local incident_output incident_id unit_name repair_status restored_health=0
  lkg_output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" restore-lkg 2>/dev/null) || return 1
  failed_commit=${FAILED_CANDIDATE_COMMIT:-${DEPLOYED_COMMIT:-$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)}}
  FAILED_CANDIDATE_COMMIT="$failed_commit"
  restored_commit=$(printf '%s\n' "$lkg_output" | jq -er '.git_commit') || return 1
  [[ "$failed_commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  failure_error="Deployment stage $CURRENT_DEPLOY_STAGE exited $deploy_status for candidate $failed_commit. The immutable last-known-good pointer was restored to $restored_commit."
  fingerprint=$(printf '%s' "$CURRENT_DEPLOY_STAGE|$deploy_status|$LAST_FAILED_COMMAND" \
    | sha256sum | awk '{print $1}')

  DEPLOYED_COMMIT="$restored_commit"
  if probe_capture_ingress && probe_service; then
    restored_health=1
  else
    systemctl restart "$SERVICE" || true
    if probe_capture_ingress && probe_service; then restored_health=1; fi
  fi
  if [ "$restored_health" = "1" ]; then
    release_deployment_gate || return 1
    recover_abandoned_gates || return 1
  else
    failure_error="$failure_error Last-known-good health could not yet be re-proven, so admission remains closed for repair."
  fi

  set +e
  incident_output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" repair-begin \
    --run-id "$DEPLOY_RUN_ID" \
    --failed-commit "$failed_commit" \
    --restored-commit "$restored_commit" \
    --failure-fingerprint "$fingerprint" \
    --error "$failure_error")
  repair_status=$?
  set -e
  echo "$incident_output"
  if [ "$repair_status" -eq 2 ]; then
    DEPLOY_RUN_TERMINAL=1
    return 0
  fi
  [ "$repair_status" -eq 0 ] || return "$repair_status"
  install -m 0644 "$CONTROL_SYSTEMD_DIR/concierge-deployment-repair@.service" \
    "$SYSTEMD_DIR/concierge-deployment-repair@.service"
  systemctl daemon-reload
  incident_id=$(printf '%s\n' "$incident_output" | jq -er '.incident_id')
  unit_name=$(printf '%s\n' "$incident_output" | jq -er '.unit_name')
  systemctl start "$unit_name"
  DEPLOY_RUN_TERMINAL=1
  echo "Autonomous trusted-root repair started as $unit_name (incident $incident_id)."
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
  for unit in concierge-bot.service agent-inbox.service \
    concierge-deployment-repair@.service; do
    src="$CONTROL_SYSTEMD_DIR/$unit"
    dest="$SYSTEMD_DIR/$unit"
    if [ ! -f "$src" ]; then
      echo "DEPLOY FAILED: required systemd source is missing: $src" >&2
      return 1
    fi
    if ! cmp -s "$src" "$dest" 2>/dev/null; then
      cp -a "$src" "$dest"
      echo "  installed $unit"
    fi
  done
  systemctl daemon-reload
}

install_deployment_runtime() {
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" install-runtime
}

require_last_known_good_release() {
  if ! CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" restore-lkg >/dev/null; then
    echo "DEPLOY FAILED: no verified immutable last-known-good release exists. Run the documented one-time trusted-root repair cutover before deploying a candidate." >&2
    return 1
  fi
}

prepare_candidate_release() {
  local output
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" prepare \
    --run-id "$DEPLOY_RUN_ID" --commit "$DEPLOYED_COMMIT")
  echo "$output"
  CANDIDATE_ARTIFACT_PATH=$(printf '%s\n' "$output" | jq -er '.artifact_path')
  CANDIDATE_ARTIFACT_DIGEST=$(printf '%s\n' "$output" | jq -er '.artifact_digest')
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" activate \
    --run-id "$DEPLOY_RUN_ID" --artifact "$CANDIDATE_ARTIFACT_PATH"
}

promote_candidate_release() {
  [ -n "$CANDIDATE_ARTIFACT_DIGEST" ] || return 0
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" promote \
    --run-id "$DEPLOY_RUN_ID" --artifact-digest "$CANDIDATE_ARTIFACT_DIGEST" \
    --artifact "$CANDIDATE_ARTIFACT_PATH"
}

install_router_actions() {
  local source="$CONTROL_SYSTEMD_DIR/router-actions.sh"
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
  install -m 0644 "$CONTROL_CONFIG_DIR/capture-routes.toml" "$CAPTURE_CONFIG_DEST"
}

probe_capture_ingress() {
  local attempt state main_pid
  for attempt in $(seq 1 10); do
    state=$(systemctl is-active agent-inbox.service 2>/dev/null || true)
    main_pid=$(systemctl show agent-inbox.service --property=MainPID --value 2>/dev/null || true)
    if [ "$state" = "active" ] && [ "${main_pid:-0}" -gt 0 ] 2>/dev/null; then
      if "$BUN_BIN" run "$CAPTURE_HEALTHCHECK_SCRIPT"; then
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
      if [ -n "$online" ] && "$BUN_BIN" run "$HEALTHCHECK_SCRIPT"; then
        if [ -n "$DEPLOY_RUN_ID" ] && [ "$runtime_sha" != "$DEPLOYED_COMMIT" ]; then
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

restore_last_known_good_and_start_repair() {
  local failure_error=$1 failure_class=$2 failed_commit=$DEPLOYED_COMMIT
  local restore_output incident_output incident_id unit_name fingerprint restore_status restore_line
  FAILED_CANDIDATE_COMMIT="$failed_commit"
  echo "Candidate deployment failed; restoring the immutable last-known-good release." >&2
  restore_line=$((LINENO + 1))
  restore_output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" restore-lkg) || {
    restore_status=$?
    record_deployment_ambiguity \
      "Candidate failed and no last-known-good release could be restored. $failure_error" \
      "The failed candidate could not be rolled back to the last-known-good release, so the live outcome could not be proven." \
      "$restore_status" \
      "$RELEASE_MANAGER_SCRIPT restore-lkg" \
      "$restore_line"
    return 1
  }
  echo "$restore_output"
  local restored_commit
  restored_commit=$(printf '%s\n' "$restore_output" | jq -er '.git_commit')
  DEPLOYED_COMMIT="$restored_commit"
  systemctl restart "$SERVICE"
  probe_capture_ingress
  probe_service
  record_deployment_phase releasing "$(jq -cn \
    --arg failed_commit "$failed_commit" \
    --arg restored_commit "$DEPLOYED_COMMIT" \
    '{candidate_failed:$failed_commit,restored_commit:$restored_commit}')"
  release_deployment_gate
  fingerprint=$(printf '%s' "candidate-restart-or-functional-health-proof|$failure_class" \
    | sha256sum | awk '{print $1}')
  set +e
  incident_output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" repair-begin \
    --run-id "$DEPLOY_RUN_ID" \
    --failed-commit "$failed_commit" \
    --restored-commit "$DEPLOYED_COMMIT" \
    --failure-fingerprint "$fingerprint" \
    --error "$failure_error")
  local repair_status=$?
  set -e
  echo "$incident_output"
  if [ "$repair_status" -eq 2 ]; then
    DEPLOY_RUN_TERMINAL=1
    return 0
  fi
  [ "$repair_status" -eq 0 ] || return "$repair_status"
  incident_id=$(printf '%s\n' "$incident_output" | jq -er '.incident_id')
  unit_name=$(printf '%s\n' "$incident_output" | jq -er '.unit_name')
  systemctl start "$unit_name"
  DEPLOY_RUN_TERMINAL=1
  echo "Last-known-good runtime is healthy. Autonomous trusted-root repair started as $unit_name (incident $incident_id)."
}

recover_interrupted_candidate_if_needed() {
  local run activation_state candidate_commit prior_status
  run=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" show --run-id "$DEPLOY_RUN_ID")
  activation_state=$(printf '%s\n' "$run" | jq -r '.activation_state // empty')
  [ "$activation_state" = "intended" ] || [ "$activation_state" = "active" ] || return 0
  candidate_commit=$(printf '%s\n' "$run" | jq -er '.candidate_commit')
  prior_status=$(printf '%s\n' "$run" | jq -r '.status')
  FAILED_CANDIDATE_COMMIT="$candidate_commit"
  DEPLOYED_COMMIT="$candidate_commit"
  CURRENT_DEPLOY_STAGE="interrupted-$prior_status-$activation_state"
  LAST_FAILED_COMMAND=deployment-runner-interrupted
  LAST_FAILURE_LINE=0
  handoff_failed_deployment_to_repair 137
  INTERRUPTED_RECOVERY_HANDLED=1
}

confirm_service_proof_is_current() {
  local proven_invocation_id=$DEPLOYED_INVOCATION_ID
  local proven_runtime_sha=$DEPLOYED_RUNTIME_SHA
  local proof_status proof_line comparison_line
  proof_line=$((LINENO + 1))
  if probe_service; then
    :
  else
    proof_status=$?
    record_deployment_ambiguity \
      "The service could not be re-proven healthy immediately before deployment success." \
      "The service could not be re-proven healthy immediately before deployment success." \
      "$proof_status" \
      "probe_service" \
      "$proof_line"
    return 1
  fi
  comparison_line=$((LINENO + 1))
  if [ "$DEPLOYED_INVOCATION_ID" != "$proven_invocation_id" ] || \
    [ "$DEPLOYED_RUNTIME_SHA" != "$proven_runtime_sha" ]; then
    record_deployment_ambiguity \
      "The service invocation or runtime commit changed after the deployment health gate; the deployed outcome is ambiguous." \
      "The service invocation or runtime commit changed after the deployment health gate; the deployed outcome is ambiguous." \
      "" \
      "service-proof-identity-comparison" \
      "$comparison_line"
    return 1
  fi
}

claim_run_and_enable_recovery() {
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  CURRENT_DEPLOY_STAGE=run-claim
  DEPLOY_FAILURE_REASON="The durable deployment run could not be claimed by this runner."
  claim_deployment_run
  trap cleanup_failed_deployment EXIT
  trap 'LAST_FAILED_COMMAND=${BASH_COMMAND%% *}; LAST_FAILURE_LINE=$LINENO' ERR
  trap 'exit 130' INT
  trap 'exit 143' TERM
  DEPLOY_FAILURE_REASON="An interrupted candidate deployment could not be recovered safely."
  recover_interrupted_candidate_if_needed
}

deploy() {
  cd "$REPO"
  if [ -n "$DEPLOY_RUN_ID" ]; then
    claim_run_and_enable_recovery
    if [ "$INTERRUPTED_RECOVERY_HANDLED" = "1" ]; then
      trap - EXIT ERR INT TERM
      return 0
    fi
  fi
  CURRENT_DEPLOY_STAGE=origin-verification
  if [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" = "1" ]; then
    DEPLOY_FAILURE_REASON="The one-time bootstrap handoff could not be validated."
    validate_bootstrap_handoff
  else
    DEPLOY_FAILURE_REASON="Git origin could not be read non-interactively with the service account's configured credentials."
    verify_git_origin
  fi
  if [ -z "$DEPLOY_RUN_ID" ] && [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" != "1" ]; then
    echo "=== create durable operator deployment run ==="
    CURRENT_DEPLOY_STAGE=state-migration
    DEPLOY_FAILURE_REASON="The deployment database could not be migrated before creating an operator run."
    CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$MIGRATION_SCRIPT"
    MIGRATION_DONE=1
    local operator_request
    DEPLOY_FAILURE_REASON="The durable operator deployment run could not be created."
    operator_request=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" operator-request)
    echo "$operator_request"
    DEPLOY_FAILURE_REASON="The durable operator deployment response was invalid."
    DEPLOY_RUN_ID=$(printf '%s\n' "$operator_request" | jq -er '.run_id')
  fi
  if [ -n "$DEPLOY_RUN_ID" ] && [ "$CURRENT_DEPLOY_STAGE" = "state-migration" ]; then
    claim_run_and_enable_recovery
  fi
  DEPLOY_FAILURE_REASON="The capture service identity or its state directories could not be prepared."
  prepare_capture_identity

  if [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" = "1" ]; then
    DEPLOY_FAILURE_REASON="The capture admission gate could not be claimed for bootstrap."
    claim_capture_gate
    DEPLOY_FAILURE_REASON="The capture admission gate could not be held for bootstrap."
    hold_capture_gate
    trap cleanup_failed_deployment EXIT
    trap 'LAST_FAILED_COMMAND=${BASH_COMMAND%% *}; LAST_FAILURE_LINE=$LINENO' ERR
    trap 'exit 130' INT
    trap 'exit 143' TERM
    echo "=== first-rollout bootstrap: service already stopped; admission is closed ==="
  else
    echo "=== atomically drain active provider turns ==="
    CURRENT_DEPLOY_STAGE=admission-drain
    DEPLOY_FAILURE_REASON="Active provider or capture ownership could not be drained safely."
    claim_deployment_gate
    [ -n "$DEPLOY_RUN_ID" ] || trap cleanup_failed_deployment EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    DEPLOY_FAILURE_REASON="The durable updating checkpoint could not be recorded after admission closed."
    record_deployment_phase updating "{\"gate\":\"claimed\"}"
    echo "=== git pull --rebase origin main ==="
    CURRENT_DEPLOY_STAGE=git-update
    DEPLOY_FAILURE_REASON="The latest origin refs could not be fetched."
    git fetch origin
    DEPLOY_FAILURE_REASON="The canonical checkout could not be rebased cleanly onto origin/main."
    if ! git pull --rebase origin main; then
      echo "DEPLOY FAILED: git pull could not rebase cleanly. Fix it in git; never copy files around git." >&2
      return 1
    fi
    DEPLOY_FAILURE_REASON="The deployed Git commit could not be resolved after updating the checkout."
    DEPLOYED_COMMIT=$(git rev-parse HEAD)
  fi

  echo "=== install frozen production dependencies ==="
  CURRENT_DEPLOY_STAGE=dependency-install
  DEPLOY_FAILURE_REASON="The frozen production dependency graph could not be installed."
  (cd "$REPO/bot" && "$BUN_BIN" install --backend=copyfile --frozen-lockfile --production)

  if [ -n "$DEPLOY_RUN_ID" ]; then
    echo "=== back up and migrate additive deployment-repair state ==="
    CURRENT_DEPLOY_STAGE=state-migration
    if [ "$MIGRATION_DONE" != "1" ]; then
      DEPLOY_FAILURE_REASON="The deployment database backup or additive migration failed."
      CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$MIGRATION_SCRIPT"
      MIGRATION_DONE=1
    fi
    DEPLOY_FAILURE_REASON="No verified immutable last-known-good release was available for rollback."
    require_last_known_good_release
  fi

  DEPLOY_FAILURE_REASON="Capture state ownership could not be assigned to the capture service account."
  chown -R "$CAPTURE_USER:$CAPTURE_USER" "$CAPTURE_STATE_DIR"

  echo "=== install/refresh systemd units ==="
  CURRENT_DEPLOY_STAGE=runtime-install
  DEPLOY_FAILURE_REASON="The trusted deployment runtime could not be installed."
  install_deployment_runtime
  DEPLOY_FAILURE_REASON="The required systemd units could not be installed or activated."
  install_systemd_units

  if [ -n "$DEPLOY_RUN_ID" ]; then
    echo "=== prepare and activate immutable candidate release ==="
    CURRENT_DEPLOY_STAGE=candidate-activation
    DEPLOY_FAILURE_REASON="The immutable candidate release could not be prepared or activated."
    prepare_candidate_release
  fi

  echo "=== install router action helper ==="
  DEPLOY_FAILURE_REASON="The router action helper could not be installed."
  install_router_actions

  echo "=== install capture ingress runtime and route config ==="
  CURRENT_DEPLOY_STAGE=capture-runtime-install
  DEPLOY_FAILURE_REASON="The capture ingress runtime or route configuration could not be installed."
  install_capture_runtime

  echo "=== install/verify capture ingress secrets ==="
  DEPLOY_FAILURE_REASON="The capture ingress credential files could not be installed or verified."
  "$BUN_BIN" run "$CAPTURE_INSTALL_SCRIPT"

  echo "=== install/verify local audio transcriber ==="
  if [ -x "$CONTROL_DIR/install-transcriber.sh" ]; then
    DEPLOY_FAILURE_REASON="The local audio transcriber could not be installed or verified."
    "$CONTROL_DIR/install-transcriber.sh"
  fi

  DEPLOY_FAILURE_REASON="The durable restarting checkpoint could not be recorded."
  record_deployment_phase restarting "{\"deployed_commit\":\"$DEPLOYED_COMMIT\",\"artifact_digest\":\"$CANDIDATE_ARTIFACT_DIGEST\"}"
  echo "=== gracefully replace $CAPTURE_SERVICE ==="
  CURRENT_DEPLOY_STAGE=capture-restart-and-health
  DEPLOY_FAILURE_REASON="The capture ingress service could not be enabled."
  systemctl enable "$CAPTURE_SERVICE" >/dev/null
  if [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" = "1" ]; then
    DEPLOY_FAILURE_REASON="New capture connections could not be blocked before replacing capture ingress."
    block_new_capture_connections
    DEPLOY_FAILURE_REASON="Existing capture connections did not drain safely."
    wait_for_capture_connections
    DEPLOY_FAILURE_REASON="The prior capture ingress process could not be stopped."
    systemctl stop "$CAPTURE_SERVICE"
    DEPLOY_FAILURE_REASON="The replacement capture ingress process could not be started."
    systemctl start "$CAPTURE_SERVICE"
    DEPLOY_FAILURE_REASON="Capture admission could not be restored after replacing capture ingress."
    unblock_capture_admission
  else
    DEPLOY_FAILURE_REASON="The capture ingress service could not be restarted."
    systemctl restart "$CAPTURE_SERVICE"
  fi
  DEPLOY_FAILURE_REASON="Capture ingress did not pass its authenticated functional health check."
  probe_capture_ingress

  if [ "$CAPTURE_DRAIN_HELD" != "1" ]; then
    DEPLOY_FAILURE_REASON="The capture delivery gate could not be held until Concierge passed functional health."
    hold_capture_gate
  fi

  echo "=== systemctl restart $SERVICE ==="
  CURRENT_DEPLOY_STAGE=candidate-restart-and-health
  DEPLOY_FAILURE_REASON="The durable verification checkpoint could not be recorded."
  record_deployment_phase verifying "{\"deployed_commit\":\"$DEPLOYED_COMMIT\"}"
  local candidate_failure="" candidate_failure_class=""
  if ! systemctl restart "$SERVICE"; then
    candidate_failure="Candidate systemd restart failed for commit $DEPLOYED_COMMIT."
    candidate_failure_class=systemd-restart
  elif ! probe_service; then
    candidate_failure="Candidate functional health or exact runtime proof failed for commit $DEPLOYED_COMMIT."
    candidate_failure_class=functional-or-runtime-proof
  fi
  if [ -n "$candidate_failure" ]; then
    restore_last_known_good_and_start_repair "$candidate_failure" "$candidate_failure_class"
    trap - EXIT ERR INT TERM
    return 0
  fi

  if [ -n "$DRAIN_TOKEN" ] || [ -n "$CAPTURE_DRAIN_TOKEN" ]; then
    DEPLOY_FAILURE_REASON="The durable admission-release checkpoint could not be recorded."
    record_deployment_phase releasing "{\"service_invocation_id\":\"$DEPLOYED_INVOCATION_ID\"}"
    DEPLOY_FAILURE_REASON="Provider or capture admission could not be reopened after health verification."
    release_deployment_gate
  fi

  if [ -n "$DEPLOY_RUN_ID" ]; then
    DEPLOY_FAILURE_REASON="The final service invocation and runtime commit could not be re-proven unchanged."
    confirm_service_proof_is_current
    DEPLOY_FAILURE_REASON="The verified candidate release could not be promoted to last-known-good."
    promote_candidate_release
    CONTROL_DIR="$CANDIDATE_ARTIFACT_PATH/control"
    CONTROL_SYSTEMD_DIR="$CONTROL_DIR/systemd"
    DEPLOY_FAILURE_REASON="The promoted release's systemd units could not be installed."
    install_systemd_units
    DEPLOY_FAILURE_REASON="Verified deployment success could not be committed to durable state."
    record_deployment_success
  fi
  trap - EXIT ERR INT TERM

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
