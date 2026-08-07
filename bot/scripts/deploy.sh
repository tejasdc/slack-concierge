#!/usr/bin/env bash
# Concierge deploy — the only supported path to update the service peer.

set -euo pipefail

REPO=${CONCIERGE_REPO:-/root/workspace/slack-concierge}
SERVICE=${CONCIERGE_SERVICE:-concierge-bot}
STATE_DIR=${CONCIERGE_STATE_DIR:-/root/.local/state/concierge}
BUN_BIN=${CONCIERGE_BUN_BIN:-/root/.bun/bin/bun}
DRAIN_INTERVAL_SECONDS=${CONCIERGE_DRAIN_INTERVAL_SECONDS:-1200}
SYSTEMD_DIR=${CONCIERGE_SYSTEMD_DIR:-/etc/systemd/system}
DEPLOY_SCRIPT="$REPO/bot/scripts/deploy.sh"
DEPLOY_OWNER_PID=$BASHPID
DRAIN_TOKEN=""

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
    --setenv=CONCIERGE_DEPLOY_DETACHED=1 \
    "$DEPLOY_SCRIPT"
  echo "Deployment is queued outside the bot cgroup. Follow it with: journalctl -fu $unit"
}

claim_deployment_gate() {
  local output status
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
        return 1
        ;;
    esac
  done
}

release_deployment_gate() {
  local status
  [ -n "$DRAIN_TOKEN" ] || return 0
  set +e
  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$REPO/bot/scripts/drain-status.ts" release "$DRAIN_TOKEN"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "WARNING: failed to release deployment gate token $DRAIN_TOKEN; startup recovery will clear it once this process exits." >&2
    return "$status"
  fi
  DRAIN_TOKEN=""
}

install_systemd_units() {
  local unit src dest
  for unit in concierge-bot.service; do
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
  systemctl daemon-reload
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

  if [ "${CONCIERGE_BOOTSTRAP_STOPPED:-0}" = "1" ]; then
    validate_bootstrap_handoff
    echo "=== first-rollout bootstrap: service already stopped; admission is closed ==="
  else
    echo "=== atomically drain active provider turns ==="
    claim_deployment_gate
    trap release_deployment_gate EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    echo "=== git pull --rebase origin main ==="
    git fetch origin
    if ! git pull --rebase origin main; then
      echo "DEPLOY FAILED: git pull could not rebase cleanly. Fix it in git; never copy files around git." >&2
      return 1
    fi
  fi

  echo "=== install/refresh systemd units ==="
  install_systemd_units

  echo "=== install/verify local audio transcriber ==="
  if [ -x "$REPO/bot/scripts/install-transcriber.sh" ]; then
    "$REPO/bot/scripts/install-transcriber.sh"
  fi

  echo "=== systemctl restart $SERVICE ==="
  systemctl restart "$SERVICE"
  probe_service

  if [ -n "$DRAIN_TOKEN" ]; then
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
