#!/usr/bin/env bash
# One-time, operator-authorized cutover from the legacy runtime to trusted-root repair.

set -euo pipefail

export HOME=${HOME:-/root}
export GIT_TERMINAL_PROMPT=0

SOURCE_ROOT=${CONCIERGE_DEPLOYMENT_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
REPO=${CONCIERGE_REPO:-/root/workspace/slack-concierge}
STATE_DIR=${CONCIERGE_STATE_DIR:-/root/.local/state/concierge}
BUN_BIN=${CONCIERGE_BUN_BIN:-/root/.bun/bin/bun}
SYSTEMD_DIR=${CONCIERGE_SYSTEMD_DIR:-/etc/systemd/system}
SERVICE=${CONCIERGE_SERVICE:-concierge-bot}
EXPECTED_LKG_COMMIT=${CONCIERGE_EXPECTED_LKG_COMMIT:-}
LEGACY_BACKUP_ROOT=${CONCIERGE_LEGACY_BACKUP_ROOT:-/var/backups/slack-concierge-deployment-cutover}

if [ "$(id -u)" -ne 0 ]; then
  echo "CUTOVER FAILED: run as root." >&2
  exit 1
fi
if ! [[ "$EXPECTED_LKG_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "CUTOVER FAILED: CONCIERGE_EXPECTED_LKG_COMMIT must name the exact healthy 40-character runtime commit." >&2
  exit 1
fi

# Reuse the established drain, capture, health, and durable-run primitives without
# invoking deploy(). Paths are rebound to the reviewed source snapshot because the
# canonical checkout deliberately remains on the healthy commit during cutover.
source "$SOURCE_ROOT/bot/scripts/deploy.sh"
DEPLOY_STATE_SCRIPT="$SOURCE_ROOT/bot/scripts/deploy-state.ts"
RELEASE_MANAGER_SCRIPT="$SOURCE_ROOT/bot/scripts/release-manager.ts"
MIGRATION_SCRIPT="$SOURCE_ROOT/bot/scripts/migrate-deployment-repair.ts"
DEPLOYED_COMMIT="$EXPECTED_LKG_COMMIT"

BOT_UNIT_BACKUP=""
CUTOVER_COMPLETE=0

app_server_identity() {
  local matches pid start_ticks executable
  matches=$(pgrep -f '^codex .*app-server --listen unix://$' || true)
  if [ "$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l)" -ne 1 ]; then
    echo "CUTOVER FAILED: expected exactly one managed Codex App Server process; found ${matches:-none}." >&2
    return 1
  fi
  pid=$matches
  start_ticks=$(awk '{print $22}' "/proc/$pid/stat")
  executable=$(readlink "/proc/$pid/exe")
  printf '%s:%s:%s\n' "$pid" "$start_ticks" "$executable"
}

online_runtime_sha() {
  local invocation
  invocation=$(systemctl show "$SERVICE" --property=InvocationID --value)
  journalctl "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager 2>/dev/null \
    | sed -n 's/.*"git_sha":"\([0-9a-f]\{40\}\)".*/\1/p' \
    | head -1
}

restore_legacy_unit() {
  [ -n "$BOT_UNIT_BACKUP" ] || return 0
  cp -a "$BOT_UNIT_BACKUP" "$SYSTEMD_DIR/concierge-bot.service"
  systemctl daemon-reload
  systemctl restart "$SERVICE"
}

cutover_failed() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [ "$CUTOVER_COMPLETE" != "1" ]; then
    restore_legacy_unit
    DEPLOYED_COMMIT="$EXPECTED_LKG_COMMIT"
    probe_capture_ingress
    probe_service
    release_deployment_gate
    record_deployment_failure "$status"
  fi
  exit "$status"
}

retire_legacy_runtime() {
  local backup unit path
  backup="$LEGACY_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 "$backup/systemd" "$backup/runtime"

  for unit in \
    concierge-deployment-coordinator.service \
    concierge-deployment-kernel.service \
    concierge-deployment-provider-adapter.service; do
    systemctl disable --now "$unit" 2>/dev/null || true
  done
  systemctl stop 'concierge-deployment-coordinator@*.service' 2>/dev/null || true
  systemctl stop 'concierge-deployment-review@*.service' 2>/dev/null || true
  systemctl stop 'concierge-deployment-rollout-review@*.service' 2>/dev/null || true
  systemctl stop 'concierge-deployment-rollout@*.service' 2>/dev/null || true
  systemctl stop 'concierge-provider-broker@*.service' 'concierge-provider-broker@*.socket' 2>/dev/null || true
  systemctl stop 'concierge-provider-worker@*.service' 'concierge-provider-worker@*.socket' 2>/dev/null || true

  for unit in \
    concierge-deployment-coordinator.service \
    concierge-deployment-coordinator@.service \
    concierge-deployment-kernel.service \
    concierge-deployment-provider-adapter.service \
    concierge-deployment-review@.service \
    concierge-deployment-rollout-review@.service \
    concierge-deployment-rollout@.service \
    concierge-provider-broker@.service \
    concierge-provider-broker@.socket \
    concierge-provider-worker@.service \
    concierge-provider-worker@.socket; do
    path="$SYSTEMD_DIR/$unit"
    [ ! -e "$path" ] || mv "$path" "$backup/systemd/"
  done
  while IFS= read -r -d '' path; do
    mv "$path" "$backup/systemd/"
  done < <(find "$SYSTEMD_DIR" -maxdepth 1 -type d \
    \( -name 'concierge-deployment-kernel.service.d' \
       -o -name 'concierge-provider-broker@*.service.d' \
       -o -name 'concierge-provider-worker@*.service.d' \) -print0)

  for path in \
    /usr/local/lib/concierge-deployment \
    /var/lib/concierge-deployment \
    /var/lib/concierge-provider \
    /var/lib/concierge-workspace \
    /var/lib/private/concierge-provider \
    /var/lib/private/concierge-provider-authority; do
    [ ! -e "$path" ] || mv "$path" "$backup/runtime/$(printf '%s' "$path" | tr '/' '_')"
  done
  systemctl daemon-reload
  echo "Retired legacy deployment runtime moved to recoverable backup $backup."
}

main() {
  local runtime_sha app_server_before app_server_after request prepared artifact_path artifact_digest
  cd "$REPO"
  runtime_sha=$(online_runtime_sha)
  if [ "$runtime_sha" != "$EXPECTED_LKG_COMMIT" ]; then
    echo "CUTOVER FAILED: live runtime reports ${runtime_sha:-no SHA}; expected $EXPECTED_LKG_COMMIT." >&2
    return 1
  fi
  git cat-file -e "$EXPECTED_LKG_COMMIT^{commit}"
  probe_capture_ingress
  DEPLOY_RUN_ID=""
  probe_service
  app_server_before=$(app_server_identity)

  CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$MIGRATION_SCRIPT"
  request=$(CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$DEPLOY_STATE_SCRIPT" operator-request)
  DEPLOY_RUN_ID=$(printf '%s\n' "$request" | jq -er '.run_id')
  claim_deployment_run
  trap cutover_failed EXIT INT TERM
  claim_deployment_gate
  hold_capture_gate
  record_deployment_phase updating "{\"initial_lkg\":\"$EXPECTED_LKG_COMMIT\"}"

  CONCIERGE_REPO="$REPO" CONCIERGE_DEPLOYMENT_SOURCE_ROOT="$SOURCE_ROOT" \
    CONCIERGE_STATE_DIR="$STATE_DIR" "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" install-runtime
  prepared=$(CONCIERGE_REPO="$REPO" CONCIERGE_STATE_DIR="$STATE_DIR" \
    "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" prepare \
    --run-id "$DEPLOY_RUN_ID" --commit "$EXPECTED_LKG_COMMIT")
  artifact_path=$(printf '%s\n' "$prepared" | jq -er '.artifact_path')
  artifact_digest=$(printf '%s\n' "$prepared" | jq -er '.artifact_digest')
  CANDIDATE_ARTIFACT_PATH="$artifact_path"
  CANDIDATE_ARTIFACT_DIGEST="$artifact_digest"
  CONCIERGE_REPO="$REPO" CONCIERGE_STATE_DIR="$STATE_DIR" \
    "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" activate \
    --run-id "$DEPLOY_RUN_ID" --artifact "$artifact_path"
  CONCIERGE_REPO="$REPO" CONCIERGE_STATE_DIR="$STATE_DIR" \
    "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" set-control --artifact "$artifact_path"

  install -d -m 0700 "$LEGACY_BACKUP_ROOT/unit"
  BOT_UNIT_BACKUP="$LEGACY_BACKUP_ROOT/unit/concierge-bot.service.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a "$SYSTEMD_DIR/concierge-bot.service" "$BOT_UNIT_BACKUP"
  install -m 0644 "$SOURCE_ROOT/systemd/concierge-bot.service" "$SYSTEMD_DIR/concierge-bot.service"
  install -m 0644 "$SOURCE_ROOT/systemd/concierge-deployment-repair@.service" \
    "$SYSTEMD_DIR/concierge-deployment-repair@.service"
  systemctl daemon-reload

  record_deployment_phase restarting "{\"initial_lkg\":\"$EXPECTED_LKG_COMMIT\"}"
  systemctl restart "$SERVICE"
  record_deployment_phase verifying "{\"initial_lkg\":\"$EXPECTED_LKG_COMMIT\"}"
  probe_capture_ingress
  probe_service
  app_server_after=$(app_server_identity)
  if [ "$app_server_after" != "$app_server_before" ]; then
    echo "CUTOVER FAILED: the shared Codex App Server identity changed ($app_server_before -> $app_server_after)." >&2
    return 1
  fi

  CONCIERGE_REPO="$REPO" CONCIERGE_STATE_DIR="$STATE_DIR" \
    "$BUN_BIN" run "$RELEASE_MANAGER_SCRIPT" promote \
    --run-id "$DEPLOY_RUN_ID" --artifact-digest "$artifact_digest" --artifact "$artifact_path"
  record_deployment_phase releasing "{\"initial_lkg\":\"$EXPECTED_LKG_COMMIT\",\"app_server_identity\":\"$app_server_after\"}"
  release_deployment_gate
  confirm_service_proof_is_current
  record_deployment_success
  CUTOVER_COMPLETE=1
  trap - EXIT INT TERM
  retire_legacy_runtime
  echo "Trusted-root deployment repair cutover is healthy at $EXPECTED_LKG_COMMIT. Canonical Git was not advanced."
}

main "$@"
