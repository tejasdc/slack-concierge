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
IPTABLES_BIN=${CONCIERGE_IPTABLES_BIN:-/usr/sbin/iptables}
SS_BIN=${CONCIERGE_SS_BIN:-/usr/bin/ss}
DEPLOY_SCRIPT="$REPO/bot/scripts/deploy.sh"
DEPLOY_STATE_SCRIPT="$REPO/bot/scripts/deploy-state.ts"
DEPLOY_OWNER_PID=$BASHPID
DEPLOY_RUN_ID=${CONCIERGE_DEPLOY_RUN_ID:-}
DEPLOY_RUN_TERMINAL=0
DEPLOYED_COMMIT=""
DEPLOYED_INVOCATION_ID=""
DEPLOYED_RUNTIME_SHA=""
DRAIN_TOKEN=""
CAPTURE_DRAIN_TOKEN=""
CAPTURE_DRAIN_HELD=0
CAPTURE_ADMISSION_BLOCKED=0
PRESERVE_GATES_ON_FAILURE=${CONCIERGE_PRESERVE_GATES_ON_FAILURE:-0}
CAPTURE_BLOCK_COMMENT=concierge-capture-bootstrap-drain
GIT_ORIGIN_VERIFIED=0

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
    --setenv=HOME="${HOME:-/root}" \
    --setenv=CONCIERGE_DRAIN_INTERVAL_SECONDS="$DRAIN_INTERVAL_SECONDS" \
    --setenv=CONCIERGE_DEPLOY_DETACHED=1 \
    "$DEPLOY_SCRIPT"
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
  output=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" \
    request --expected-commit "$expected_commit")
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
    --setenv=CONCIERGE_DEPLOY_DETACHED=1 \
    --setenv=CONCIERGE_DEPLOY_RUN_ID="$DEPLOY_RUN_ID" \
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
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" claim \
    --run-id "$DEPLOY_RUN_ID" --owner-pid "$DEPLOY_OWNER_PID"
}

record_deployment_phase() {
  local phase=$1 detail=${2:-{}}
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" phase \
    --run-id "$DEPLOY_RUN_ID" --phase "$phase" --detail "$detail"
}

record_deployment_failure() {
  local deploy_status=$1
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
  [ -n "$DEPLOY_RUN_ID" ] || return 0
  local evidence
  evidence=$(jq -cn \
    --arg capture "functional health passed" \
    --arg service "functional health passed" \
    --arg runtime_sha "$DEPLOYED_RUNTIME_SHA" \
    '{capture_probe:$capture,service_probe:$service,runtime_sha:$runtime_sha,admission_gates:"released"}')
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" succeed \
    --run-id "$DEPLOY_RUN_ID" \
    --repo "$REPO" \
    --deployed-commit "$DEPLOYED_COMMIT" \
    --service-invocation-id "$DEPLOYED_INVOCATION_ID" \
    --evidence "$evidence"
  DEPLOY_RUN_TERMINAL=1
}

record_deployment_ambiguity() {
  local error=$1
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
        sleep "$DRAIN_INTERVAL_SECONDS"
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
        sleep "$DRAIN_INTERVAL_SECONDS"
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
  release_turn_gate || status=$?
  release_capture_gate force || status=$?
  return "$status"
}

cleanup_failed_deployment() {
  local deploy_status=$?
  record_deployment_failure "$deploy_status" || true
  if [ "$PRESERVE_GATES_ON_FAILURE" = "1" ]; then
    echo "DEPLOY FAILED during the project-scaffold cutover. Admission gates remain held and $SERVICE must stay stopped until the documented recovery is completed." >&2
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
    sleep "$DRAIN_INTERVAL_SECONDS"
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
  for unit in concierge-bot.service agent-inbox.service; do
    src="$REPO/systemd/$unit"
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
  chmod +x "$REPO/bot/scripts/healthcheck.ts" 2>/dev/null || true
  chmod +x "$REPO/bot/scripts/capture-healthcheck.ts" 2>/dev/null || true
  chmod +x "$REPO/bot/scripts/install-capture-ingress.ts" 2>/dev/null || true
  chmod +x "$REPO/bot/scripts/capture-drain-status.ts" 2>/dev/null || true
  systemctl daemon-reload
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
  cd "$REPO"
  if [ -n "$DEPLOY_RUN_ID" ]; then
    claim_deployment_run
    trap cleanup_failed_deployment EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
  fi
  if [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" = "1" ]; then
    validate_bootstrap_handoff
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
    claim_deployment_gate
    [ -n "$DEPLOY_RUN_ID" ] || trap cleanup_failed_deployment EXIT
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

  echo "=== systemctl restart $SERVICE ==="
  systemctl restart "$SERVICE"
  record_deployment_phase verifying "{\"deployed_commit\":\"$DEPLOYED_COMMIT\"}"
  probe_service

  if [ -n "$DRAIN_TOKEN" ] || [ -n "$CAPTURE_DRAIN_TOKEN" ]; then
    record_deployment_phase releasing "{\"service_invocation_id\":\"$DEPLOYED_INVOCATION_ID\"}"
    release_deployment_gate
  fi

  if [ -n "$DEPLOY_RUN_ID" ]; then
    confirm_service_proof_is_current
    record_deployment_success
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
