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
echo "=== install/refresh systemd units (backup timers, etc.) ==="
for unit in concierge-backup-state.service concierge-backup-state.timer \
            concierge-backup-config.service concierge-backup-config.timer; do
  src="$REPO/systemd/$unit"
  dest="/etc/systemd/system/$unit"
  if [ ! -f "$src" ]; then
    echo "  skip $unit (source missing)"; continue
  fi
  if ! cmp -s "$src" "$dest" 2>/dev/null; then
    cp -a "$src" "$dest"
    echo "  installed $unit"
  fi
done
chmod +x "$REPO/bot/scripts/backup-state.sh" "$REPO/bot/scripts/backup-config.sh" 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now concierge-backup-state.timer concierge-backup-config.timer 2>&1 | grep -v "^$" | head -5

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
