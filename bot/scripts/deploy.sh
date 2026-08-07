#!/usr/bin/env bash
# Concierge deploy — the ONLY path to update AX41 (see AGENTS.md
# "Deploy discipline — no scp, ever").
#
# Runs on AX41. Pulls latest main from origin, restarts concierge-bot.
# If pull fails (merge conflict, unclean tree), STOPS — do not resolve
# by scp'ing. Fix in git, re-run.

set -euo pipefail

REPO=/root/workspace/slack-concierge
SERVICE=concierge-bot

cd "$REPO"

echo "=== git pull --rebase origin main ==="
git fetch origin
if ! git pull --rebase origin main; then
  echo
  echo "DEPLOY FAILED: git pull could not rebase cleanly."
  echo "Diagnose the conflict, fix it in git, then re-run this script."
  echo "DO NOT scp files as a workaround. See AGENTS.md 'Deploy discipline'."
  exit 1
fi

echo
echo "=== systemctl restart $SERVICE ==="
systemctl restart "$SERVICE"
sleep 2
STATE=$(systemctl is-active "$SERVICE")
echo "service state: $STATE"

if [ "$STATE" != "active" ]; then
  echo "SERVICE FAILED TO COME UP. Recent logs:"
  journalctl -u "$SERVICE" --since '30 sec ago' --no-pager | tail -30
  exit 2
fi

echo
echo "=== deploy complete ==="
git log -1 --oneline
