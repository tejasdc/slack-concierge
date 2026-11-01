#!/bin/sh
set -eu
bot=${CONCIERGE_ROUTER_BOT_DIR:?Mac browser fallback needs its pinned Concierge source}
bun="$HOME/Library/Application Support/concierge/bun/bin/bun"
exec "$bun" run "$bot/scripts/mac-browser-fallback.js" "$@"
