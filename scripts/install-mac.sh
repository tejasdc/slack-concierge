#!/usr/bin/env bash
# Install or update the Mac Concierge instance as a launchd agent for the current user.
# Idempotent: re-run after `git pull` to restart on the new source. See docs/runbooks/PEER-INSTANCES.md.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE=${CONCIERGE_MAC_STATE_DIR:-"$HOME/Library/Application Support/concierge"}
LABEL=com.tejasdc.concierge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UPDATE_LABEL=com.tejasdc.concierge-update
UPDATE_PLIST="$HOME/Library/LaunchAgents/$UPDATE_LABEL.plist"
BUN="$STATE/bun/bin/bun"
BUN_VERSION=${CONCIERGE_MAC_BUN_VERSION:-1.3.14}
PEERS=${CONCIERGE_PEERS:-'[{"name":"cloud","url":"http://100.118.245.110:8788","paths":["/root/"]}]'}
TAILNET_IP=${CONCIERGE_PEER_HOST:-$(ifconfig | awk '/inet 100\./{print $2; exit}')}
CLAUDE=${CONCIERGE_CLAUDE_CODE_EXECUTABLE:-$(command -v claude || echo "$HOME/.local/bin/claude")}
# Codex runs the way remote-box runs it: the managed standalone package's app-server daemon
# (systemd/concierge-bot.service ExecStartPre). The package is installed by codex's own installer.
MANAGED_CODEX="$HOME/.codex/packages/standalone/current/codex"
CODEX=${CONCIERGE_CODEX_EXECUTABLE:-$( [ -x "$MANAGED_CODEX" ] && "$MANAGED_CODEX" --version >/dev/null 2>&1 && echo "$MANAGED_CODEX" || command -v codex || echo /opt/homebrew/bin/codex)}
NODE=${CONCIERGE_NODE_BIN:-$( [ -x "$HOME/.local/share/fnm/aliases/default/bin/node" ] && echo "$HOME/.local/share/fnm/aliases/default/bin/node" || command -v node)}

# Stopping the agent stops every process it started. An install launched from inside it (a
# Mac session updating its own Concierge) would die at bootout and leave the agent down, as on
# 2026-09-18. Hand that case to the separate update job, which runs outside the agent.
if [ "${XPC_SERVICE_NAME:-}" = "$LABEL" ]; then
  if launchctl print "gui/$(id -u)/$UPDATE_LABEL" >/dev/null 2>&1; then
    launchctl kickstart "gui/$(id -u)/$UPDATE_LABEL"
    echo "Handed the update to $UPDATE_LABEL; it pulls, restarts Concierge and logs to $STATE/logs/update.log."
    exit 0
  fi
  echo "Refusing to restart Concierge from inside itself: $UPDATE_LABEL is not installed yet. Run this once from a terminal." >&2
  exit 2
fi

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
# Same as remote-box's ExecStartPre: start the managed app-server daemon if it is not running.
if ! "$CODEX" app-server daemon start >/dev/null 2>&1 || ! "$CODEX" app-server daemon version 2>/dev/null | grep -q '"status":"running"'; then
  echo "Codex app-server daemon is not running. Install the managed package with: curl -fsSL https://chatgpt.com/codex/install.sh | sh" >&2
fi
install -m 0755 "$REPO/systemd/router-actions.sh" "$HOME/.local/bin/router-actions.sh"

# Speech-to-text: Apple's on-device engine behind the same protocol as the box's Parakeet
# (bot/src/speech-engine.ts). Rebuilt only when its source changes. Running it once with no
# input installs the locale's speech assets now, so the first dictation does not wait on them.
SPEECH_SRC="$REPO/bot/native/apple-speech-server.swift"
SPEECH_BIN="$STATE/speech/apple-speech-server"
if [ "$(sw_vers -productVersion | cut -d. -f1)" -lt 26 ]; then
  echo "Speech-to-text needs macOS 26 or later; recordings will be kept but not transcribed here." >&2
elif ! command -v swiftc >/dev/null 2>&1; then
  echo "Speech-to-text needs the Swift compiler: run 'xcode-select --install', then this script again." >&2
else
  mkdir -p "$STATE/speech"
  speech_fingerprint=$(shasum -a 256 "$SPEECH_SRC" | cut -d' ' -f1)
  if [ ! -x "$SPEECH_BIN" ] || [ "$(cat "$STATE/speech/.fingerprint" 2>/dev/null)" != "$speech_fingerprint" ]; then
    swiftc -O "$SPEECH_SRC" -o "$SPEECH_BIN.build" && mv "$SPEECH_BIN.build" "$SPEECH_BIN" && echo "$speech_fingerprint" > "$STATE/speech/.fingerprint"
  fi
  "$SPEECH_BIN" "${CONCIERGE_SPEECH_LOCALE:-en-US}" </dev/null >/dev/null || echo "Apple speech assets did not install; see the message above." >&2
fi
command -v ffmpeg >/dev/null 2>&1 || echo "Speech-to-text also needs ffmpeg to read browser recordings: brew install ffmpeg" >&2

# Screenshots for agents (bot/native/mac-capture.swift, run through ~/.local/bin/mac-screenshot).
# Nothing here asks for the Screen Recording permission: the helper asks the first time a
# capture is actually wanted, and macOS attributes it to the signed agent-host app above it.
CAPTURE_SRC="$REPO/bot/native/mac-capture.swift"
CAPTURE_BIN="$STATE/capture/mac-capture"
if ! command -v swiftc >/dev/null 2>&1; then
  echo "Agent screenshots need the Swift compiler: run 'xcode-select --install', then this script again." >&2
else
  mkdir -p "$STATE/capture"
  capture_fingerprint=$(shasum -a 256 "$CAPTURE_SRC" | cut -d' ' -f1)
  if [ ! -x "$CAPTURE_BIN" ] || [ "$(cat "$STATE/capture/.fingerprint" 2>/dev/null)" != "$capture_fingerprint" ]; then
    swiftc -O "$CAPTURE_SRC" -o "$CAPTURE_BIN.build" && mv "$CAPTURE_BIN.build" "$CAPTURE_BIN" && echo "$capture_fingerprint" > "$STATE/capture/.fingerprint"
  fi
fi
install -m 0755 "$REPO/scripts/mac-screenshot" "$HOME/.local/bin/mac-screenshot"

# Safari refuses an https page's requests to plain http on this Mac (checked in WebKit 26,
# September 21, 2026), so the browser's live dictation also gets https on 127.0.0.1. The
# certificate names only this Mac's loopback address and cannot sign anything else. It is
# regenerated a month before it expires; trusting it is the one password prompt, asked at the
# end of this script so a prompt nobody answers never holds Concierge down.
SPEECH_TLS="$STATE/speech/tls"
mkdir -p "$SPEECH_TLS"; chmod 700 "$SPEECH_TLS"
if [ ! -s "$SPEECH_TLS/cert.pem" ] || ! /usr/bin/openssl x509 -checkend 2592000 -noout -in "$SPEECH_TLS/cert.pem" >/dev/null 2>&1; then
  cat > "$SPEECH_TLS/req.cnf" <<CONF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=Concierge speech on this Mac
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,DNS:localhost
CONF
  # Apple accepts at most 825 days for a certificate trusted by the user.
  (umask 077; /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 800 -config "$SPEECH_TLS/req.cnf" \
    -keyout "$SPEECH_TLS/key.pem" -out "$SPEECH_TLS/cert.pem" >/dev/null 2>&1)
  rm -f "$SPEECH_TLS/req.cnf" "$SPEECH_TLS/.trusted"
fi

# Built before launchd is touched: a build or signing failure leaves the running agent alone.
LAUNCHER=$("$REPO/scripts/build-mac-agent-host.sh" "$REPO" "$STATE" | tail -1)
[ -x "$LAUNCHER" ] || { echo "The agent-host app did not build; Concierge was left as it was." >&2; exit 2; }

sed -e "s|@HOME@|$HOME|g" -e "s|@REPO@|$REPO|g" -e "s|@STATE@|$STATE|g" -e "s|@TAILNET_IP@|$TAILNET_IP|g" -e "s|@LAUNCHER@|$LAUNCHER|g" \
    -e "s|@PEERS@|$PEERS|g" -e "s|@CLAUDE@|$CLAUDE|g" -e "s|@CODEX@|$CODEX|g" -e "s|@NODE@|$NODE|g" \
    "$REPO/launchd/$LABEL.plist" > "$PLIST.tmp"
plutil -lint "$PLIST.tmp" >/dev/null
mv "$PLIST.tmp" "$PLIST"

# The update job is loaded once and never reloaded from inside itself.
sed -e "s|@HOME@|$HOME|g" -e "s|@REPO@|$REPO|g" -e "s|@STATE@|$STATE|g" "$REPO/launchd/$UPDATE_LABEL.plist" > "$UPDATE_PLIST.tmp"
plutil -lint "$UPDATE_PLIST.tmp" >/dev/null
mv "$UPDATE_PLIST.tmp" "$UPDATE_PLIST"
if [ "${XPC_SERVICE_NAME:-}" != "$UPDATE_LABEL" ]; then
  launchctl bootout "gui/$(id -u)/$UPDATE_LABEL" 2>/dev/null || true
  for _ in $(seq 1 30); do launchctl print "gui/$(id -u)/$UPDATE_LABEL" >/dev/null 2>&1 || break; sleep 1; done
  launchctl bootstrap "gui/$(id -u)" "$UPDATE_PLIST"
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the service is gone; a bootstrap in that window fails silently.
for _ in $(seq 1 30); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Concierge (mac) started: state $STATE, peer listener $TAILNET_IP:8788, logs $STATE/logs/"

speech_cert=$(shasum -a 256 "$SPEECH_TLS/cert.pem" 2>/dev/null | cut -d' ' -f1)
if [ -n "$speech_cert" ] && [ "$(cat "$SPEECH_TLS/.trusted" 2>/dev/null)" != "$speech_cert" ]; then
  echo "macOS will ask for your password once to trust Concierge's local speech address, so Safari can dictate on this Mac."
  if security add-trusted-cert -r trustRoot -p ssl -k "$HOME/Library/Keychains/login.keychain-db" "$SPEECH_TLS/cert.pem"; then
    echo "$speech_cert" > "$SPEECH_TLS/.trusted"
  else
    echo "Not trusted: Safari keeps server transcription until this script runs again and the prompt is accepted." >&2
  fi
fi
