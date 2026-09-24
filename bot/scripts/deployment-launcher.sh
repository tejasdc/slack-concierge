#!/usr/bin/env bash

set -euo pipefail

RUNTIME_ROOT=${CONCIERGE_DEPLOYMENT_RELEASE_ROOT:-/var/lib/slack-concierge-deployment}
INSTALL_ROOT=${CONCIERGE_DEPLOYMENT_RUNTIME_DIR:-/usr/local/lib/slack-concierge-deployment}
RELEASE_MANIFEST="$RUNTIME_ROOT/current/manifest.json"
RELEASE_APPLICATION="$RUNTIME_ROOT/current/bot/src/index.js"

if [ -f "$RELEASE_MANIFEST" ] && [ -f "$RELEASE_APPLICATION" ]; then
  export CONCIERGE_RELEASE_MANIFEST="$RELEASE_MANIFEST"
  exec "$INSTALL_ROOT/bun" "$RELEASE_APPLICATION"
fi

echo "Installed Concierge release is missing; refusing to execute a writable checkout." >&2
exit 1
