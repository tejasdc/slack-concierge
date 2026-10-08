#!/usr/bin/env bash
set -euo pipefail
unit=${MONITOR_UNIT:-${1:?failed unit required}}
invocation=${MONITOR_INVOCATION_ID:-}
if [[ -z "$invocation" ]]; then
  invocation=$(systemctl show --property=InvocationID --value "$unit")
fi
[[ -n "$invocation" ]] || { echo "Cannot identify the failed service invocation for $unit" >&2; exit 1; }
# systemd runs this the moment the service fails, before its own restart. A unit waiting in
# auto-restart is coming straight back; saying it "stopped after repeated failures" and "will
# need inspection" misdescribed every crash it recovered from (2026-10-07).
sub_state=$(systemctl show --property=SubState --value "$unit" || true)
restarts=$(systemctl show --property=NRestarts --value "$unit" || true)
when=$(TZ=America/New_York date '+%-I:%M %p')
# One notice per episode: a service failing to start keeps restarting every few seconds, and each
# restart used to file its own notice (five within a minute on 2026-10-08). Only the first failure
# after a deliberate start is announced; if it never recovers, the "stopped" notice follows.
if [[ "$sub_state" == "auto-restart" && "${restarts:-0}" != "0" ]]; then
  echo "${unit} restart ${restarts} in an episode already announced; no new notice"
  exit 0
fi
if [[ "$sub_state" == "auto-restart" ]]; then
  title="${unit} crashed and is restarting"
  body="${unit} crashed at ${when} and is restarting on its own (restart ${restarts:-?} since it was last started deliberately). Work that was running at that moment was interrupted."
else
  title="${unit} stopped"
  body="${unit} stopped at ${when} and is not restarting on its own. It needs inspection before it can start again."
fi
exec /usr/local/lib/slack-concierge-deployment/bun run /var/lib/slack-concierge-deployment/current/control/bot/scripts/service-notice.js \
  --key "systemd-failure:${unit}:${invocation}" \
  --title "$title" \
  -- "$body"
