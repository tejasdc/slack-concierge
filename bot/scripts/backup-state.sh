#!/usr/bin/env bash
# Hourly hot-copy backup of the concierge state.db.
# Uses SQLite's online .backup so we don't need to stop the bot.
# Retention: keep 24 hourly + 14 daily (first-of-day) + 8 weekly (Sunday first-of-day).
#
# Off-box push (Hetzner Storage Box or any rsync target): if
# /etc/concierge/backup-target.conf exists, its contents are sourced as
# RSYNC_TARGET (e.g. RSYNC_TARGET=u12345@u12345.your-storagebox.de:/concierge)
# and the backup dir is rsynced there after each hourly run.

set -euo pipefail

STATE_DB=/root/.local/state/concierge/state.db
BACKUP_DIR=/var/backups/concierge/state
LOG=/var/log/concierge-backup.log

mkdir -p "$BACKUP_DIR"
touch "$LOG"

log() { printf '[%s] state-backup: %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

if [ ! -f "$STATE_DB" ]; then
  log "state.db missing at $STATE_DB — nothing to back up"
  exit 0
fi

STAMP=$(date -u +'%Y%m%d-%H%M%S')
DOW=$(date -u +'%u')          # 1=Mon..7=Sun
HOUR=$(date -u +'%H')
DEST_HOURLY="$BACKUP_DIR/hourly/state-$STAMP.db"

mkdir -p "$BACKUP_DIR/hourly" "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

sqlite3 "$STATE_DB" ".backup '$DEST_HOURLY'"
gzip -f "$DEST_HOURLY"
log "hourly snapshot: $DEST_HOURLY.gz ($(stat -c %s "$DEST_HOURLY.gz") bytes)"

# First run of the day promotes to daily.
if [ "$HOUR" = "00" ] || ! ls "$BACKUP_DIR/daily/state-$(date -u +%Y%m%d)"-*.db.gz 2>/dev/null | grep -q .; then
  cp -a "$DEST_HOURLY.gz" "$BACKUP_DIR/daily/state-$(date -u +%Y%m%d)-daily.db.gz"
  log "daily promoted"
  # Sunday first-of-day also promotes to weekly.
  if [ "$DOW" = "7" ]; then
    cp -a "$DEST_HOURLY.gz" "$BACKUP_DIR/weekly/state-$(date -u +%Y%m%d)-weekly.db.gz"
    log "weekly promoted"
  fi
fi

# Retention: last 24 hourly, 14 daily, 8 weekly.
prune() {
  local dir=$1 keep=$2
  ls -1t "$dir"/*.db.gz 2>/dev/null | tail -n +"$((keep+1))" | while read -r f; do rm -f "$f"; log "pruned $f"; done
}
prune "$BACKUP_DIR/hourly" 24
prune "$BACKUP_DIR/daily" 14
prune "$BACKUP_DIR/weekly" 8

# Off-box push if configured.
if [ -f /etc/concierge/backup-target.conf ]; then
  # shellcheck disable=SC1091
  . /etc/concierge/backup-target.conf
  if [ -n "${RSYNC_TARGET:-}" ]; then
    if rsync -az --delete "$BACKUP_DIR/" "$RSYNC_TARGET/state/" 2>>"$LOG"; then
      log "pushed to $RSYNC_TARGET/state/"
    else
      log "off-box push FAILED (rsync exit $?)"
    fi
  fi
fi
