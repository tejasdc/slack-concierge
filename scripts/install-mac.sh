#!/usr/bin/env bash
# Install or update the Mac Concierge instance as a launchd agent for the current user.
# Idempotent: re-run after `git pull` to restart on the new source. See docs/runbooks/PEER-INSTANCES.md.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE=${CONCIERGE_MAC_STATE_DIR:-"$HOME/Library/Application Support/concierge"}
LABEL=com.tejasdc.concierge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUN="$STATE/bun/bin/bun"
BUN_VERSION=${CONCIERGE_MAC_BUN_VERSION:-1.3.14}
PEERS=${CONCIERGE_PEERS:-'[{"name":"cloud","url":"http://100.118.245.110:8788"}]'}
TAILNET_IP=${CONCIERGE_PEER_HOST:-$(ifconfig | awk '/inet 100\./{print $2; exit}')}
CLAUDE=${CONCIERGE_CLAUDE_CODE_EXECUTABLE:-$(command -v claude || echo "$HOME/.local/bin/claude")}
CODEX=${CONCIERGE_CODEX_EXECUTABLE:-$(command -v codex || echo /opt/homebrew/bin/codex)}
NODE=${CONCIERGE_NODE_BIN:-$( [ -x "$HOME/.local/share/fnm/aliases/default/bin/node" ] && echo "$HOME/.local/share/fnm/aliases/default/bin/node" || command -v node)}

[ -n "$TAILNET_IP" ] || { echo "No tailnet address (100.x) is up; start Tailscale first or set CONCIERGE_PEER_HOST." >&2; exit 2; }
[ -x "$CLAUDE" ] || { echo "claude executable not found at $CLAUDE" >&2; exit 2; }

mkdir -p "$STATE/logs" "$HOME/.local/bin" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE"
if [ ! -x "$BUN" ] || [ "$("$BUN" --version)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$STATE/bun" bash -s "bun-v$BUN_VERSION"
fi
if [ ! -s "$STATE/peer.token" ]; then
  (umask 077; openssl rand -hex 32 > "$STATE/peer.token")
  echo "Generated $STATE/peer.token; install the same bytes on every peer (see the runbook)."
fi
chmod 600 "$STATE/peer.token"

(cd "$REPO/bot" && "$BUN" install --frozen-lockfile)
# Codex sessions use the Mac's own app-server daemon; starting it is idempotent and Claude does not need it.
"$CODEX" app-server daemon start >/dev/null 2>&1 || echo "Codex app-server daemon did not start; Codex sessions will be unavailable until it does."
install -m 0755 "$REPO/systemd/router-actions.sh" "$HOME/.local/bin/router-actions.sh"

sed -e "s|@HOME@|$HOME|g" -e "s|@REPO@|$REPO|g" -e "s|@STATE@|$STATE|g" -e "s|@TAILNET_IP@|$TAILNET_IP|g" \
    -e "s|@PEERS@|$PEERS|g" -e "s|@CLAUDE@|$CLAUDE|g" -e "s|@CODEX@|$CODEX|g" -e "s|@NODE@|$NODE|g" \
    "$REPO/launchd/$LABEL.plist" > "$PLIST.tmp"
plutil -lint "$PLIST.tmp" >/dev/null
mv "$PLIST.tmp" "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the service is gone; a bootstrap in that window fails silently.
for _ in $(seq 1 30); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Concierge (mac) started: state $STATE, peer listener $TAILNET_IP:8788, logs $STATE/logs/"
