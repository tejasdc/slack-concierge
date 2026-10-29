#!/usr/bin/env bash
# Keep the Mac's npm-owned browser CLI at the version whose idle shutdown we exercise.
set -euo pipefail

node=${1:?Expected the Mac Node executable}
bin=$(dirname "$node")
npm="$bin/npm"
browser="$bin/agent-browser"
version=0.27.0

[ -x "$node" ] || { echo "Node is unavailable at $node" >&2; exit 2; }
[ -x "$npm" ] || { echo "npm is unavailable at $npm" >&2; exit 2; }

if [ -x "$browser" ] && [ "$("$browser" --version 2>/dev/null || true)" = "agent-browser $version" ]; then
  echo "agent-browser $version is installed."
  exit 0
fi

PATH="$bin:$PATH" "$npm" install -g "agent-browser@$version"
[ -x "$browser" ] && [ "$("$browser" --version)" = "agent-browser $version" ] || {
  echo "agent-browser $version did not install under $bin" >&2
  exit 1
}
echo "Installed agent-browser $version for Mac agent work."
