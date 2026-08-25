#!/usr/bin/env bash
# One-time bridge from the pre-ownership runtime to drain-aware deployments.
# Fetch this script from origin/main and execute it before the first rollout.

set -euo pipefail

export HOME=${HOME:-/root}
export GIT_TERMINAL_PROMPT=0

REPO=${CONCIERGE_REPO:-/root/workspace/slack-concierge}
SERVICE=${CONCIERGE_SERVICE:-concierge-bot}
APPLICATION_TARGET_STATE_DIR=${CONCIERGE_APPLICATION_TARGET_STATE_DIR:-/var/lib/concierge-bot/state}
DRAIN_INTERVAL_SECONDS=${CONCIERGE_DRAIN_INTERVAL_SECONDS:-1200}
CGROUP_ROOT=${CONCIERGE_CGROUP_ROOT:-/sys/fs/cgroup}
BOOTSTRAP_SCRIPT=$(realpath "${BASH_SOURCE[0]}")

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
        *) echo "BOOTSTRAP FAILED: the live service application state directory is not absolute." >&2; return 1 ;;
      esac
    fi
    printf '%s\n' /root/.local/state/concierge
    return 0
  fi
  if [ -e "$APPLICATION_TARGET_STATE_DIR/state.db" ]; then
    echo "BOOTSTRAP FAILED: live service state could not be resolved after containment; refusing the retired root database." >&2
    return 1
  fi
  printf '%s\n' /root/.local/state/concierge
}

inside_concierge_service() {
  grep -q "${SERVICE}\.service" /proc/self/cgroup 2>/dev/null
}

handoff_from_concierge_service() {
  local unit="concierge-bootstrap-$(date +%s)-$$" state_dir
  state_dir=$(resolve_live_state_dir)
  systemd-run --unit "$unit" --collect --no-block --property=Type=exec \
    --setenv=HOME="${HOME:-/root}" \
    --setenv=CONCIERGE_STATE_DIR="$state_dir" \
    --setenv=CONCIERGE_CAPTURE_STATE_DIR="${CONCIERGE_CAPTURE_STATE_DIR:-/var/lib/concierge-capture}" \
    --setenv=CONCIERGE_BOOTSTRAP_DETACHED=1 "$BOOTSTRAP_SCRIPT"
  echo "Bootstrap queued outside the bot cgroup. Follow it with: journalctl -fu $unit"
}

service_processes() {
  local control_group main_pid pid
  main_pid=$(systemctl show "$SERVICE" --property=MainPID --value)
  control_group=$(systemctl show "$SERVICE" --property=ControlGroup --value)
  [ -n "$control_group" ] || return 1
  [ -r "$CGROUP_ROOT$control_group/cgroup.procs" ] || return 1
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$main_pid" ] || printf '%s\n' "$pid"
  done < "$CGROUP_ROOT$control_group/cgroup.procs"
}

wait_for_legacy_turns() {
  local children status
  while systemctl is-active --quiet "$SERVICE"; do
    set +e
    children=$(service_processes)
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
      echo "BOOTSTRAP FAILED: cannot inspect the legacy service cgroup safely." >&2
      return 1
    fi
    if [ -z "$children" ]; then
      # Close the old runtime's admission race before declaring it drained.
      # A second cgroup inspection while frozen proves no provider slipped in
      # between the first inspection and the freeze.
      systemctl freeze "$SERVICE"
      set +e
      children=$(service_processes)
      status=$?
      set -e
      if [ "$status" -ne 0 ]; then
        systemctl thaw "$SERVICE" || true
        echo "BOOTSTRAP FAILED: cannot verify the frozen legacy cgroup." >&2
        return 1
      fi
      if [ -z "$children" ]; then
        echo "Legacy admission frozen with no provider children."
        return 0
      fi
      systemctl thaw "$SERVICE"
    fi
    echo "Legacy service still owns child process(es): $(printf '%s' "$children" | tr '\n' ' '). Checking again in $DRAIN_INTERVAL_SECONDS seconds."
    sleep "$DRAIN_INTERVAL_SECONDS"
  done
}

bootstrap_deploy() {
  local bootstrap_token token_file updated_commit state_dir
  state_dir=$(resolve_live_state_dir)
  cd "$REPO"
  echo "=== bootstrap: fetch drain-aware release without changing the checkout ==="
  git fetch origin

  echo "=== bootstrap: wait for legacy provider children ==="
  wait_for_legacy_turns

  echo "=== bootstrap: stop frozen legacy admission ==="
  systemctl stop "$SERVICE"

  bootstrap_token=$(</proc/sys/kernel/random/uuid)
  token_file="$state_dir/bootstrap-deploy.token"

  echo "=== bootstrap: update checkout while service is stopped ==="
  if ! git pull --rebase origin main; then
    echo "BOOTSTRAP FAILED: pull failed. $SERVICE remains stopped so old code cannot admit work." >&2
    return 1
  fi
  updated_commit=$(git rev-parse HEAD)
  umask 077
  printf '%s\n%s\n' "$bootstrap_token" "$updated_commit" > "$token_file"

  echo "=== bootstrap: install and start drain-aware runtime ==="
  CONCIERGE_BOOTSTRAP_STOPPED=1 CONCIERGE_BOOTSTRAP_TOKEN="$bootstrap_token" \
    CONCIERGE_BOOTSTRAP_UPDATED_COMMIT="$updated_commit" \
    CONCIERGE_STATE_DIR="$state_dir" \
    CONCIERGE_DEPLOY_DETACHED=1 "$REPO/bot/scripts/deploy.sh"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "${CONCIERGE_BOOTSTRAP_DETACHED:-0}" != "1" ] && inside_concierge_service; then
    handoff_from_concierge_service
    exit 0
  fi
  bootstrap_deploy
fi
