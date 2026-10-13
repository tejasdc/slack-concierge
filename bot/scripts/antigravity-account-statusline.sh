#!/bin/sh
# The documented Antigravity status-line payload names the account and plan.
# Keep only those nonsecret fields for the account reader; never retain the full payload.
set -eu
umask 077
case "$(uname -s)" in
  Darwin) default_identity_dir="$HOME/Library/Application Support/concierge" ;;
  *) default_identity_dir="$HOME/.local/state/concierge" ;;
esac
identity_dir="${CONCIERGE_ANTIGRAVITY_IDENTITY_DIR:-$default_identity_dir}"
mkdir -p "$identity_dir"
staging=$(mktemp "$identity_dir/antigravity-identity.XXXXXX")
# The CLI ends a slow status line with a signal, which skips an EXIT trap in sh: 92 staging
# files had piled up on the Mac by 2026-10-13.
trap 'rm -f "$staging"' EXIT
trap 'rm -f "$staging"; exit 1' HUP INT TERM
if jq -ce --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  'select((.email|type)=="string" and (.email|test("^[^@]+@[^@]+\\.[^@]+$"))) |
   {email,plan:(.plan_tier // null),observedAt:$observedAt}' > "$staging"; then
  mv "$staging" "$identity_dir/antigravity-identity.json"
fi
