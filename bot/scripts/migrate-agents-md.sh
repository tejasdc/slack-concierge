#!/usr/bin/env bash
# Compatibility entry point. Migration is registry-scoped and dry-run by default.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUN_BIN=${CONCIERGE_BUN_BIN:-/root/.bun/bin/bun}

exec "$BUN_BIN" run "$SCRIPT_DIR/migrate-project-scaffolds.ts" "$@"
