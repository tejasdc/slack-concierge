#!/usr/bin/env bash
# Daily tarball of config + operator state that isn't in git (state.db has
# its own hourly path — see backup-state.sh). Everything the bot needs to
# be restored on a fresh box.
#
# Includes:
#   /root/.config/concierge          — slack.toml (tokens), etc.
#   /root/.local/state/concierge     — WAL, seen files, migration processed lists
#   /root/.local/bin                 — helper scripts (router-actions, etc.)
#   /etc/systemd/system/concierge-*  — service + timer units
#   /etc/concierge                   — backup-target.conf and future config
#
# Retention: 14 daily + 8 weekly. Same off-box push hook as backup-state.sh.

set -euo pipefail

BACKUP_DIR=/var/backups/concierge/config
LOG=/var/log/concierge-backup.log

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
touch "$LOG"

log() { printf '[%s] config-backup: %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

STAMP=$(date -u +'%Y%m%d')
DOW=$(date -u +'%u')
DEST="$BACKUP_DIR/daily/config-$STAMP.tar.gz"

tar czf "$DEST" \
  --absolute-names \
  --ignore-failed-read \
  /root/.config/concierge \
  /root/.local/state/concierge \
  /root/.local/bin \
  /etc/concierge \
  /etc/systemd/system/concierge-bot.service \
  /etc/systemd/system/concierge-backup-state.timer \
  /etc/systemd/system/concierge-backup-state.service \
  /etc/systemd/system/concierge-backup-config.timer \
  /etc/systemd/system/concierge-backup-config.service \
  /etc/systemd/system/monologue-poll.timer \
  /etc/systemd/system/monologue-poll.service \
  2>>"$LOG" || true

log "daily tarball: $DEST ($(stat -c %s "$DEST") bytes)"

if [ "$DOW" = "7" ]; then
  cp -a "$DEST" "$BACKUP_DIR/weekly/config-$STAMP-weekly.tar.gz"
  log "weekly promoted"
fi

prune() {
  local dir=$1 keep=$2
  ls -1t "$dir"/*.tar.gz 2>/dev/null | tail -n +"$((keep+1))" | while read -r f; do rm -f "$f"; log "pruned $f"; done
}
prune "$BACKUP_DIR/daily" 14
prune "$BACKUP_DIR/weekly" 8

# See backup-state.sh comment block for backup-target.conf shape.
if [ -f /etc/concierge/backup-target.conf ]; then
  # shellcheck disable=SC1091
  . /etc/concierge/backup-target.conf
  if [ -n "${RSYNC_TARGET:-}" ]; then
    if rsync -az --delete -e "${RSYNC_SSH:-ssh}" "$BACKUP_DIR/" "$RSYNC_TARGET/config/" 2>>"$LOG"; then
      log "pushed to $RSYNC_TARGET/config/"
    else
      log "off-box push FAILED (rsync exit $?)"
    fi
  fi
fi
