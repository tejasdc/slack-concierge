#!/usr/bin/env bash
# Concierge deploy — the only supported path to update the service peer.

set -euo pipefail

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
DEPLOY_OWNER_PID=$BASHPID
DRAIN_TOKEN=""
CAPTURE_DRAIN_TOKEN=""
CAPTURE_DRAIN_HELD=0
CAPTURE_ADMISSION_BLOCKED=0
PRESERVE_GATES_ON_FAILURE=${CONCIERGE_PRESERVE_GATES_ON_FAILURE:-0}
CAPTURE_BLOCK_COMMENT=concierge-capture-bootstrap-drain

validate_bootstrap_handoff() {
  local token_file expected_token
  token_file="$STATE_DIR/bootstrap-deploy.token"
  expected_token=${CONCIERGE_BOOTSTRAP_TOKEN:-}
  if systemctl is-active --quiet "$SERVICE"; then
    echo "DEPLOY FAILED: bootstrap bypass refused because $SERVICE is still active." >&2
    return 1
  fi
  if [ -z "$expected_token" ] || [ ! -f "$token_file" ] || [ "$(<"$token_file")" != "$expected_token" ]; then
    echo "DEPLOY FAILED: bootstrap bypass requires the one-time token created after stopping $SERVICE." >&2
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
  local attempt state main_pid invocation_id online
  for attempt in $(seq 1 10); do
    state=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
    main_pid=$(systemctl show "$SERVICE" --property=MainPID --value 2>/dev/null || true)
    invocation_id=$(systemctl show "$SERVICE" --property=InvocationID --value 2>/dev/null || true)
    online=""
    if [ -n "$invocation_id" ]; then
      online=$(journalctl "_SYSTEMD_INVOCATION_ID=$invocation_id" --no-pager 2>/dev/null | grep -m1 "concierge_bot_online" || true)
    fi
    if [ "$state" = "active" ] && [ "${main_pid:-0}" -gt 0 ] 2>/dev/null; then
      if [ -n "$online" ] && "$BUN_BIN" run "$REPO/bot/scripts/healthcheck.ts"; then
        echo "Service probe passed (state=$state, MainPID=$main_pid, socket startup logged, Slack auth.test=ok)."
        return 0
      fi
    fi
    [ "$attempt" -eq 10 ] || sleep 3
  done

  echo "SERVICE FAILED FUNCTIONAL PROBE. Recent logs:" >&2
  journalctl -u "$SERVICE" --since "2 min ago" --no-pager | tail -50 >&2
  return 1
}

deploy() {
  cd "$REPO"
  prepare_capture_identity

  if [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" = "1" ]; then
    validate_bootstrap_handoff
    claim_capture_gate
    hold_capture_gate
    trap cleanup_failed_deployment EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    echo "=== first-rollout bootstrap: service already stopped; admission is closed ==="
  else
    echo "=== atomically drain active provider turns ==="
    claim_deployment_gate
    trap cleanup_failed_deployment EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    echo "=== git pull --rebase origin main ==="
    git fetch origin
    if ! git pull --rebase origin main; then
      echo "DEPLOY FAILED: git pull could not rebase cleanly. Fix it in git; never copy files around git." >&2
      return 1
    fi
  fi

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
  probe_service

  if [ -n "$DRAIN_TOKEN" ] || [ -n "$CAPTURE_DRAIN_TOKEN" ]; then
    release_deployment_gate
    trap - EXIT INT TERM
  fi

  echo "=== deploy complete ==="
  git log -1 --oneline
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "${CONCIERGE_DEPLOY_DETACHED:-0}" != "1" ] && inside_concierge_service; then
    handoff_from_concierge_service
    exit 0
  fi
  deploy
fi
