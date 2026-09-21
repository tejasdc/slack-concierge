#!/usr/bin/env bash
# Build and sign the Mac agent-host app that launchd runs in front of bun, so macOS names
# the app, not "bun", in permission prompts. Called by install-mac.sh; prints the app's
# executable path. See docs/runbooks/PEER-INSTANCES.md ("Permission prompts on the Mac").
#
# The app is signed with a dedicated local key kept in the state directory. macOS remembers
# approvals by the bundle identifier and that key, so changing the display name, or
# rebuilding the launcher, keeps Full Disk Access. The key is created once; deleting the
# signing directory means approving the app again.
set -euo pipefail

REPO=${1:?repo}
STATE=${2:?state}
DISPLAY_NAME=${CONCIERGE_MAC_APP_NAME:-Thinkering}
SRC="$REPO/launchd/agent-host"
APP="$STATE/app/$DISPLAY_NAME.app"
SIGN="$STATE/signing"
KEYCHAIN="$SIGN/agent-host-signing.keychain-db"
IDENTITY_NAME="Tejas agent-host local signing"

mkdir -p "$SIGN" "$STATE/app"
chmod 700 "$SIGN"
if [ ! -s "$SIGN/keychain.pass" ]; then (umask 077; openssl rand -hex 24 > "$SIGN/keychain.pass"); fi
PASS=$(cat "$SIGN/keychain.pass")

# One signing identity, created once and reused forever. A keychain left without it by an
# interrupted first run is rebuilt; one that holds it is never replaced.
if [ -f "$KEYCHAIN" ] && ! security find-certificate -c "$IDENTITY_NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  security delete-keychain "$KEYCHAIN" 2>/dev/null || rm -f "$KEYCHAIN"
fi
if [ ! -f "$KEYCHAIN" ]; then
  work=$(mktemp -d)
  cat > "$work/req.cnf" <<CONF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$IDENTITY_NAME
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CONF
  openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$work/req.cnf" -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1
  security create-keychain -p "$PASS" "$KEYCHAIN"
  security set-keychain-settings "$KEYCHAIN"
  security unlock-keychain -p "$PASS" "$KEYCHAIN"
  # Key and certificate go in separately: macOS rejects the PKCS#12 bundles LibreSSL writes.
  security import "$work/key.pem" -k "$KEYCHAIN" -t priv -f openssl -T /usr/bin/codesign >/dev/null
  security import "$work/cert.pem" -k "$KEYCHAIN" -t cert -f pemseq >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASS" "$KEYCHAIN" >/dev/null
  rm -rf "$work"
fi
security unlock-keychain -p "$PASS" "$KEYCHAIN"

# Rebuild only when the launcher, its metadata or the name changes.
fingerprint=$( { cat "$SRC/launcher.c" "$SRC/Info.plist"; echo "$DISPLAY_NAME"; } | shasum -a 256 | cut -d' ' -f1)
if [ -x "$APP/Contents/MacOS/agent-host" ] && [ "$(cat "$STATE/app/.fingerprint" 2>/dev/null)" = "$fingerprint" ] \
   && codesign --verify --strict "$APP" >/dev/null 2>&1; then
  echo "$APP/Contents/MacOS/agent-host"
  exit 0
fi

# Any app built under an earlier display name goes, so only one copy holds the approvals.
for old in "$STATE/app/"*.app; do if [ -e "$old" ] && [ "$old" != "$APP" ]; then rm -rf "$old"; fi; done
rm -rf "$APP.build"
mkdir -p "$APP.build/Contents/MacOS"
clang -O2 -Wall -o "$APP.build/Contents/MacOS/agent-host" "$SRC/launcher.c"
sed -e "s|@DISPLAY_NAME@|$DISPLAY_NAME|g" "$SRC/Info.plist" > "$APP.build/Contents/Info.plist"
plutil -lint "$APP.build/Contents/Info.plist" >/dev/null
IDENTITY=$(security find-certificate -c "$IDENTITY_NAME" -Z "$KEYCHAIN" | awk '/SHA-1 hash:/{print $3; exit}')
codesign --force --keychain "$KEYCHAIN" --sign "$IDENTITY" --identifier com.tejasdc.agent-host "$APP.build"
rm -rf "$APP"
mv "$APP.build" "$APP"
# Outside the bundle: an extra file inside it would break the signature seal.
echo "$fingerprint" > "$STATE/app/.fingerprint"
echo "$APP/Contents/MacOS/agent-host"
