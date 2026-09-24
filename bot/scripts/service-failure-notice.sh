#!/usr/bin/env bash
set -euo pipefail
unit=${MONITOR_UNIT:-${1:?failed unit required}}
invocation=${MONITOR_INVOCATION_ID:-}
if [[ -z "$invocation" ]]; then
  invocation=$(systemctl show --property=InvocationID --value "$unit")
fi
[[ -n "$invocation" ]] || { echo "Cannot identify the failed service invocation for $unit" >&2; exit 1; }
exec /usr/local/lib/slack-concierge-deployment/bun run /root/workspace/slack-concierge/bot/scripts/service-notice.ts \
  --key "systemd-failure:${unit}:${invocation}" \
  --title "${unit} stopped" \
  -- "${unit} stopped after repeated failures. The service will need inspection before it can start again."
