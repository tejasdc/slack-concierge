#!/usr/bin/env bash

set -euo pipefail

RUNTIME_ROOT=${CONCIERGE_DEPLOYMENT_RELEASE_ROOT:-/var/lib/slack-concierge-deployment}
INSTALL_ROOT=${CONCIERGE_DEPLOYMENT_RUNTIME_DIR:-/usr/local/lib/slack-concierge-deployment}
RELEASE_MANIFEST="$RUNTIME_ROOT/current/manifest.json"
RELEASE_APPLICATION="$RUNTIME_ROOT/current/bot/src/index.js"

if [ -f "$RELEASE_MANIFEST" ] && [ -f "$RELEASE_APPLICATION" ]; then
  STATE_ROOT=${CONCIERGE_STATE_DIR:-/root/.local/state/concierge}
  REQUIREMENT="$STATE_ROOT/codex-native-mutation/required-release-protocols/v1.json"
  if [ -e "$REQUIREMENT" ] || [ -L "$REQUIREMENT" ]; then
    APPLICATION_ROOT=$(readlink -f "$RUNTIME_ROOT/current")
    CONTROL_ARTIFACT=$(readlink -f "$RUNTIME_ROOT/control")
    CHECKER="$CONTROL_ARTIFACT/control/codex-mutation-release-check.js"
    [ -f "$CHECKER" ] || { echo 'CODEX_MUTATION_CONTROL_PROTOCOL_NOT_PROVEN' >&2; exit 1; }
    "$INSTALL_ROOT/bun" "$CHECKER" startup --app "$APPLICATION_ROOT" --control "$CONTROL_ARTIFACT" --state "$STATE_ROOT"
    RELEASE_MANIFEST="$APPLICATION_ROOT/manifest.json"
    RELEASE_APPLICATION="$APPLICATION_ROOT/bot/src/index.js"
  fi
  export CONCIERGE_RELEASE_MANIFEST="$RELEASE_MANIFEST"
  exec "$INSTALL_ROOT/bun" "$RELEASE_APPLICATION"
fi

echo "Installed Concierge release is missing; refusing to execute a writable checkout." >&2
exit 1
