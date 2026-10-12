#!/bin/sh
# Give the current server release one stable, sanitized Google account identity source.
set -eu
if [ "$(uname -s)" != Linux ]; then exit 0; fi
release_root="${CONCIERGE_DEPLOYMENT_RELEASE_ROOT:-/var/lib/slack-concierge-deployment}"
hook="$release_root/current/control/antigravity-account-statusline.sh"
settings="$HOME/.gemini/antigravity-cli/settings.json"
if [ ! -x /root/.local/bin/agy ]; then exit 0; fi
if [ ! -x "$hook" ]; then echo "Antigravity account hook is missing from the installed release." >&2; exit 1; fi
command -v jq >/dev/null 2>&1 || { echo "Antigravity account hook requires jq." >&2; exit 1; }
mkdir -p "$(dirname "$settings")"
umask 077
if [ ! -e "$settings" ]; then printf '{}\n' > "$settings"; fi
previous=$(jq -er '.statusLine.command // ""' "$settings") || {
  echo "Antigravity settings could not be read." >&2; exit 1;
}
case "$previous" in
  ''|"$hook"|*/bot/scripts/antigravity-account-statusline.sh) ;;
  *) echo "Antigravity already has a different status-line command; account identity hook was not installed." >&2; exit 1 ;;
esac
staging=$(mktemp "$(dirname "$settings")/settings.XXXXXX")
trap 'rm -f "$staging"' EXIT
jq --arg hook "$hook" '.statusLine = ((.statusLine // {}) +
  {type:"command", command:$hook, enabled:true, stack_with_default:true})' "$settings" > "$staging"
chmod 600 "$staging"
mv "$staging" "$settings"
