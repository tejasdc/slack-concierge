#!/usr/bin/env bash

set -euo pipefail

RELEASE_ROOT=${CONCIERGE_DEPLOYMENT_RELEASE_ROOT:-/var/lib/slack-concierge-deployment}
INSTALL_ROOT=${CONCIERGE_DEPLOYMENT_RUNTIME_DIR:-/usr/local/lib/slack-concierge-deployment}
CONTROL_ROOT="$RELEASE_ROOT/control/control"
export CONCIERGE_DEPLOYMENT_CONTROL_ROOT="$CONTROL_ROOT"
export CONCIERGE_DEPLOY_COMMAND="$INSTALL_ROOT/control"

case "${1:-}" in
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
  *)
    echo "usage: $0 <deploy|repair|recover> [arguments]" >&2
    exit 2
    ;;
esac
