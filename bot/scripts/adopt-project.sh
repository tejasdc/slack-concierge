#!/usr/bin/env bash
# Compatibility entry point. Scaffold policy lives in src/project-scaffold.ts.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUN_BIN=${CONCIERGE_BUN_BIN:-/root/.bun/bin/bun}

exec "$BUN_BIN" run "$SCRIPT_DIR/adopt-project.ts" "$@"
