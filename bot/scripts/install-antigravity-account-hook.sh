#!/bin/sh
# Give the current server release one stable, sanitized Google account identity source.
set -eu
if [ "$(uname -s)" != Linux ]; then exit 0; fi
hook_dir="$HOME/.local/share/concierge"
hook="$hook_dir/antigravity-account-statusline.sh"
staged_hook="${1:?candidate hook path required}"
settings="$HOME/.gemini/antigravity-cli/settings.json"
if [ ! -x /root/.local/bin/agy ]; then exit 0; fi
if [ ! -x "$staged_hook" ]; then echo "Antigravity account hook is missing from the candidate release." >&2; exit 1; fi
command -v jq >/dev/null 2>&1 || { echo "Antigravity account hook requires jq." >&2; exit 1; }
mkdir -p "$hook_dir"
mkdir -p "$(dirname "$settings")"
umask 077
if [ ! -e "$settings" ]; then printf '{}\n' > "$settings"; fi
previous=$(jq -er '.statusLine.command // ""' "$settings") || {
  echo "Antigravity settings could not be read." >&2; exit 1;
}
case "$previous" in
  ''|"$hook"|*/bot/scripts/antigravity-account-statusline.sh|*/current/control/antigravity-account-statusline.sh) ;;
  *) echo "Antigravity already has a different status-line command; account identity hook was not installed." >&2; exit 1 ;;
esac
staged_copy=$(mktemp "$hook_dir/statusline.XXXXXX")
trap 'rm -f "$staged_copy" "${staging:-}"' EXIT
cp "$staged_hook" "$staged_copy"
chmod 700 "$staged_copy"
mv "$staged_copy" "$hook"
staging=$(mktemp "$(dirname "$settings")/settings.XXXXXX")
jq --arg hook "$hook" '.statusLine = ((.statusLine // {}) +
  {type:"command", command:$hook, enabled:true, stack_with_default:true})' "$settings" > "$staging"
chmod 600 "$staging"
mv "$staging" "$settings"
