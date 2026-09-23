#!/usr/bin/env bash
# Installs Concierge's Stop hook as a Codex *managed* hook, so every Codex agent on this machine is
# held to the request protocol the same way Claude agents are (bot/scripts/owed-reply-stop-hook.ts).
#
# Codex runs a non-managed hook only after a person reviews and trusts its exact definition;
# managed hooks from requirements.toml are "trusted by policy" and cannot be disabled by the user
# (https://learn.chatgpt.com/docs/hooks, "Review and trust hooks"; "Managed hooks from
# requirements.toml"). The system requirements file is /etc/codex/requirements.toml on Linux and
# macOS (https://learn.chatgpt.com/codex/enterprise/managed-configuration, "Locations and
# precedence"), and Codex does not distribute managed scripts: the installer puts them under
# managed_dir itself. Writing /etc needs root: remote-box's deploy runs this on the box; on the Mac
# it runs once with sudo, from scripts/install-mac.sh in a terminal.
#
# Usage: install-codex-stop-hook.sh --bun <bun> --bot <repo>/bot --state <concierge state dir>
set -euo pipefail

bun= bot= state=
while [ $# -gt 0 ]; do
  case "$1" in
    --bun) bun=$2; shift 2 ;;
    --bot) bot=$2; shift 2 ;;
    --state) state=$2; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -x "$bun" ] || { echo "No bun runtime at: $bun" >&2; exit 2; }
[ -f "$bot/scripts/owed-reply-stop-hook.ts" ] || { echo "No Concierge hook under: $bot" >&2; exit 2; }
[ -d "$state" ] || { echo "No Concierge state directory: $state" >&2; exit 2; }

etc=${CODEX_SYSTEM_DIR:-/etc/codex}
marker='# Managed by slack-concierge scripts/install-codex-stop-hook.sh.'
requirements="$etc/requirements.toml"
if [ -e "$requirements" ] && ! head -1 "$requirements" | grep -Fq "$marker"; then
  echo "$requirements exists and was not written by this installer; merge the [hooks] block by hand." >&2
  exit 1
fi

hook="$etc/hooks/concierge-owed-reply"
if [ -e "$hook" ] && ! grep -Fq "$marker" "$hook"; then
  echo "$hook exists and was not written by this installer; refusing to replace it." >&2
  exit 1
fi
mkdir -p "$etc/hooks"
tmp=$(mktemp)
cat > "$tmp" <<EOF
#!/bin/sh
$marker
# Codex runs this as a managed Stop hook; it asks Concierge whether the agent still owes a reply.
CONCIERGE_STATE_DIR='$state' CONCIERGE_STATE_DB='$state/state.db' exec '$bun' run '$bot/scripts/owed-reply-stop-hook.ts' codex
EOF
install -m 0755 "$tmp" "$hook"
cat > "$tmp" <<EOF
$marker Do not edit by hand.
# Concierge's end-of-turn check for every Codex agent on this machine: an agent that tries to end
# its turn while it still owes a reply to a request is sent back once with the exact command.
# Pinned on so a local "hooks = false" cannot turn it off ("To enforce managed hooks even for users
# who disabled hooks locally, pin [features].hooks = true alongside [hooks]").
[features]
hooks = true

[hooks]
managed_dir = "$etc/hooks"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "$hook"
timeout = 20
statusMessage = "Checking for replies this agent still owes"
EOF
install -m 0644 "$tmp" "$requirements"
rm -f "$tmp"
echo "Installed Codex managed Stop hook: $requirements -> $hook"
