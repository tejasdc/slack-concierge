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
# It also installs the machine's refusal of rewritten history (2026-09-23): the history guard as a
# Codex managed PreToolUse hook and in Claude Code's managed settings, and git's machine-wide
# pre-push check through install-git-history-guard.sh --system.
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
[ -f "$bot/scripts/owed-reply-stop-hook.ts" ] && [ -f "$bot/scripts/history-guard.ts" ] || { echo "No Concierge hooks under: $bot" >&2; exit 2; }
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

# The same machine refuses any agent command that rewrites pushed history
# (bot/scripts/history-guard.ts), for Codex here and for Claude in its machine settings below.
guard="$etc/hooks/concierge-history-guard"
if [ -e "$guard" ] && ! grep -Fq "$marker" "$guard"; then
  echo "$guard exists and was not written by this installer; refusing to replace it." >&2
  exit 1
fi
cat > "$tmp" <<EOF
#!/bin/sh
$marker
# Codex and Claude run this before every command; it refuses one that rewrites pushed history.
exec '$bun' run '$bot/scripts/history-guard.ts'
EOF
install -m 0755 "$tmp" "$guard"
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

# Pushed history is never rewritten: a forced push, or amending or rebasing a pushed commit, is
# refused before it runs (bot/scripts/history-guard.ts; Tejas, 2026-09-23).
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "$guard"
timeout = 20
statusMessage = "Checking this does not rewrite pushed history"
EOF
install -m 0644 "$tmp" "$requirements"
echo "Installed Codex managed hooks: $requirements -> $hook, $guard"

# The approval check that ran before every agent command was removed on 2026-09-23: agents keep
# full control of this machine (Tejas). Its launcher stays gone; the machine settings file it used
# now carries only the history guard, which he asked for the same evening.
rm -f "$etc/hooks/concierge-protected-change"

# Claude Code's machine-wide managed settings carry the history guard for every Claude process
# here, including one not started by Concierge; Concierge also passes it with --settings
# (claude-code.ts) for machines where this has not run. The file is managed-settings.json in
# /etc/claude-code on Linux and /Library/Application Support/ClaudeCode on macOS
# (https://code.claude.com/docs/en/settings#settings-files).
if [ -z "${CLAUDE_SYSTEM_DIR:-}" ] && [ "$(uname -s)" = Darwin ]; then claude_etc="/Library/Application Support/ClaudeCode"
else claude_etc=${CLAUDE_SYSTEM_DIR:-/etc/claude-code}; fi
managed="$claude_etc/managed-settings.json"
if [ -e "$managed" ] && [ ! -e "$claude_etc/.concierge-managed" ]; then
  echo "$managed exists and was not written by this installer; add the history guard by hand." >&2
  exit 1
fi
mkdir -p "$claude_etc"
printf '%s\n' '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"'"$guard"'","timeout":20}]}]}}' > "$tmp"
install -m 0644 "$tmp" "$managed"
printf '%s\n' "$marker" > "$claude_etc/.concierge-managed"
rm -f "$tmp"
echo "Installed Claude Code managed history guard: $managed -> $guard"

# git itself refuses the push too, for every checkout and worktree, whatever runs it.
"$(dirname "$0")/install-git-history-guard.sh" --system
