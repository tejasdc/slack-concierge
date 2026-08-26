#!/usr/bin/env bash

set -euo pipefail

WORKTREE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKTREE_ROOT/bot"
bun install --frozen-lockfile
