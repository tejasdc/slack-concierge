#!/usr/bin/env bash

set -euo pipefail

RUNTIME_ROOT=${CONCIERGE_DEPLOYMENT_RELEASE_ROOT:-/var/lib/concierge-deployment}
CONTROL_ROOT=${CONCIERGE_DEPLOYMENT_RUNTIME_DIR:-/usr/local/lib/concierge-deployment}
REPOSITORY_ROOT=${CONCIERGE_REPOSITORY_ROOT:-/root/workspace/slack-concierge}
RELEASE_MANIFEST="$RUNTIME_ROOT/current/manifest.json"
RELEASE_APPLICATION="$RUNTIME_ROOT/current/bot/src/index.js"

if [ -f "$RELEASE_MANIFEST" ] && [ -f "$RELEASE_APPLICATION" ]; then
  export CONCIERGE_RELEASE_MANIFEST="$RELEASE_MANIFEST"
  exec "$CONTROL_ROOT/bun" "$RELEASE_APPLICATION"
fi

exec "$CONTROL_ROOT/bun" "$REPOSITORY_ROOT/bot/src/index.ts"
