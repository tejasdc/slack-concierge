#!/usr/bin/env bash

set -euo pipefail

RELEASE_ROOT=${CONCIERGE_DEPLOYMENT_RELEASE_ROOT:-/var/lib/slack-concierge-deployment}
INSTALL_ROOT=${CONCIERGE_DEPLOYMENT_RUNTIME_DIR:-/usr/local/lib/slack-concierge-deployment}
# A restore or promotion may replace the pointer during this invocation. Keep
# every helper on the verified artifact that supplied this runner.
CONTROL_ROOT=$(readlink -f "$RELEASE_ROOT/control/control")
export CONCIERGE_DEPLOYMENT_CONTROL_ROOT="$CONTROL_ROOT"
export CONCIERGE_DEPLOY_COMMAND="$INSTALL_ROOT/control"
STATE_ROOT=${CONCIERGE_STATE_DIR:-/root/.local/state/concierge}
REQUIREMENT="$STATE_ROOT/codex-native-mutation/required-release-protocols/v1.json"
if [ -e "$REQUIREMENT" ] || [ -L "$REQUIREMENT" ]; then
  APPLICATION_ROOT=$(readlink -f "$RELEASE_ROOT/current")
  CONTROL_ARTIFACT=$(dirname "$CONTROL_ROOT")
  CHECKER="$CONTROL_ROOT/codex-mutation-release-check.js"
  [ -f "$CHECKER" ] || { echo 'CODEX_MUTATION_CONTROL_PROTOCOL_NOT_PROVEN' >&2; exit 1; }
  # Repair/control commands may roll forward the incompatible application. The
  # actual application start checks both identities before executing any app.
  "$INSTALL_ROOT/bun" "$CHECKER" control --control "$CONTROL_ARTIFACT" --state "$STATE_ROOT"
fi

case "${1:-}" in
  codex-launch|codex-proxy)
    shift
    exec "$INSTALL_ROOT/bun" "$CONTROL_ROOT/codex-managed-launch.js" "$@"
    ;;
  deploy)
    shift
    exec /usr/bin/bash "$CONTROL_ROOT/deploy.sh" "$@"
    ;;
  repair)
    shift
    exec "$INSTALL_ROOT/bun" "$CONTROL_ROOT/deployment-repair.js" "$@"
    ;;
  recover)
    shift
    exec "$INSTALL_ROOT/bun" "$CONTROL_ROOT/recover-deployment.js" "$@"
    ;;
  history-cache)
    shift
    # Like deploy, this is a host-owned operation, not a source command reading
    # through an agent's deliberately hidden state mount. Pin the sealed release.
    HISTORY_RELEASE=$(readlink -f "$RELEASE_ROOT/current")
    exec systemd-run --wait --pipe --collect --unit="concierge-history-cache-$(date +%s%N)" \
      --description="Concierge exact-generation history cache maintenance" \
      --property=UMask=0077 --property=Nice=10 --property=Slice=agents.slice \
      --setenv=HOME=/root --setenv=CONCIERGE_STATE_DIR=/root/.local/state/concierge \
      "$INSTALL_ROOT/bun" "$HISTORY_RELEASE/control/history-cache.js" "$@"
    ;;
  *)
    echo "usage: $0 <deploy|repair|recover|history-cache|codex-launch|codex-proxy> [arguments]" >&2
    exit 2
    ;;
esac
