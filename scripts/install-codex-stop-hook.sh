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

bun= bot= state= release=
while [ $# -gt 0 ]; do
  case "$1" in
    --bun) bun=$2; shift 2 ;;
    --bot) bot=$2; shift 2 ;;
    --release) release=$2; shift 2 ;;
    --state) state=$2; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -x "$bun" ] || { echo "No bun runtime at: $bun" >&2; exit 2; }
if [ -n "$release" ]; then
  [ -f "$release/control/bot/scripts/owed-reply-stop-hook.js" ] && [ -f "$release/control/bot/scripts/history-guard.js" ] && [ -f "$release/control/bot/scripts/live-store-copy-guard.js" ] && [ -f "$release/control/ensure-codex-updater-disabled.js" ] || { echo "No release hooks or updater policy under: $release" >&2; exit 2; }
  bot="$release/control/bot"
  updater_policy="$release/control/ensure-codex-updater-disabled.js"
  suffix=js
else
  [ -f "$bot/scripts/owed-reply-stop-hook.ts" ] && [ -f "$bot/scripts/history-guard.ts" ] && [ -f "$bot/scripts/live-store-copy-guard.ts" ] && [ -f "$bot/scripts/ensure-codex-updater-disabled.ts" ] || { echo "No Concierge hooks or updater policy under: $bot" >&2; exit 2; }
  updater_policy="$bot/scripts/ensure-codex-updater-disabled.ts"
  suffix=ts
fi
[ -d "$state" ] || { echo "No Concierge state directory: $state" >&2; exit 2; }

# The server deploy runs this before restarting the service. Its daemon start must never
# ensure Codex's autonomous updater, which can terminate an admitted provider turn.
# This installer runs as root on the server; the Mac installer applies the same preference
# as the console user before it invokes this script with sudo for machine-wide hooks.
if [ "$(uname -s)" = Linux ]; then
  "$bun" run "$updater_policy" /root/.codex/app-server-daemon/settings.json
fi

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
if [ "$suffix" = js ]; then
  # Resolve the release symlink now. A later rollback can move /current to an older
  # artifact without removing the machine policy already installed for running agents.
  current_guard=$(cd "$(dirname "$bot/scripts/live-store-copy-guard.js")" && pwd -P)/live-store-copy-guard.js
else
  # The Mac installs from a checkout that updates in place; seal this one check under
  # the machine hook directory so a checkout rollback cannot replace it mid-run.
  current_guard="$etc/hooks/concierge-live-store-copy.js"
  "$bun" build "$bot/scripts/live-store-copy-guard.ts" --target bun --outfile "$tmp"
  install -m 0644 "$tmp" "$current_guard"
fi
# Both wrappers dispatch per run (marker line "dispatch: per-run v2", HOOK_DISPATCH_MARKER in
# bot/src/hook-pins.ts): the hook runs from the helper folder of the version that started the run,
# so an update never changes those semantic hooks under a running agent. The history wrapper first
# runs the installed release's raw-live-copy refusal, which must also protect already-running agents.
# Pinned semantic dispatch then follows, in order:
#   1. a shared Codex daemon turn: the folder Concierge filed under its conversation id, which the
#      hook receives as session_id on stdin (<state>/hook-pins/codex/<id>);
#   2. a run Concierge started in a host: its own CONCIERGE_ROUTER_BOT_DIR;
#   3. any other agent: the installed copy.
dispatch='# dispatch: per-run v2'
# write_wrapper <path> <hook script name> <description> <environment prefix> <arguments>
write_wrapper() {
  cat > "$tmp" <<EOF
#!/bin/sh
$marker
$dispatch
# $3
input=\$(cat)
# current-live-store-copy v1: machine policy runs before the pinned per-run hook.
if [ '$2' = history-guard ]; then
  current='$current_guard'
  if [ ! -f "\$current" ]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The current live-store copy guard is unavailable; retry after Concierge hook installation."}}'
    exit 0
  fi
  if decision=\$(printf '%s' "\$input" | '$bun' run "\$current"); then :
  else
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The current live-store copy guard could not run; retry after Concierge hook installation."}}'
    exit 0
  fi
  if [ -n "\$decision" ]; then printf '%s\n' "\$decision"; exit 0; fi
fi
dir='$bot' suffix='$suffix' run=''
id=\$(printf '%s' "\$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9-]*\)".*/\1/p' | head -n 1)
if [ -n "\$id" ] && [ -f '$state/hook-pins/codex/'"\$id" ]; then run=\$(head -n 1 '$state/hook-pins/codex/'"\$id")
elif [ -n "\${CONCIERGE_ROUTER_BOT_DIR:-}" ]; then run=\$CONCIERGE_ROUTER_BOT_DIR; fi
if [ -n "\$run" ]; then
  if [ -f "\$run/scripts/$2.js" ]; then dir=\$run suffix=js
  elif [ -f "\$run/scripts/$2.ts" ]; then dir=\$run suffix=ts; fi
fi
printf '%s' "\$input" | $4'$bun' run "\$dir/scripts/$2.\$suffix"$5
EOF
  install -m 0755 "$tmp" "$1"
}
write_wrapper "$hook" owed-reply-stop-hook "Codex runs this as a managed Stop hook; it asks Concierge whether the agent still owes a reply." \
  "CONCIERGE_STATE_DIR='$state' CONCIERGE_STATE_DB='$state/state.db' " " codex"

# The same machine refuses any agent command that rewrites pushed history
# (bot/scripts/history-guard.ts), for Codex here and for Claude in its machine settings below.
guard="$etc/hooks/concierge-history-guard"
if [ -e "$guard" ] && ! grep -Fq "$marker" "$guard"; then
  echo "$guard exists and was not written by this installer; refusing to replace it." >&2
  exit 1
fi
write_wrapper "$guard" history-guard "Codex and Claude run this before every command; it refuses one that rewrites pushed history." "" ""

# A machine-local check the host deploy may provide (remote-box installs it on the server): before
# a command touches an agent worktree whose packages its daily cleanup removed, it reinstalls them,
# so a resumed or new session never depends on what the cleanup took. It never refuses a command.
# Registered only when present, so a machine without it gets exactly the hooks above.
restore="$etc/hooks/remote-box-worktree-restore"
restore_codex='' restore_claude=''
if [ -x "$restore" ]; then
  restore_codex=$(printf '%s\n' '' \
    '# Reinstalls packages the worktree cleanup removed before a command uses that worktree' \
    '# (remote-box scripts/worktree-restore-hook.sh). A first npm reinstall takes about 20 seconds.' \
    '[[hooks.PreToolUse]]' '[[hooks.PreToolUse.hooks]]' 'type = "command"' \
    "command = \"$restore\"" 'timeout = 900' \
    "statusMessage = \"Reinstalling packages this worktree's cleanup removed\"")
  restore_claude=',{"matcher":"Bash","hooks":[{"type":"command","command":"'"$restore"'","timeout":900}]}'
fi
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
$restore_codex
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
printf '%s\n' '{"hooks":{"PreToolUse":[{"matcher":"Bash|Read|Grep|Glob|NotebookRead|mcp__.*(navigate|new_page|open_url|goto).*","hooks":[{"type":"command","command":"'"$guard"'","timeout":20}]}'"$restore_claude"']}}' > "$tmp"
install -m 0644 "$tmp" "$managed"
printf '%s\n' "$marker" > "$claude_etc/.concierge-managed"
rm -f "$tmp"
echo "Installed Claude Code managed history guard: $managed -> $guard"

# The Codex desktop app's SSH payload starts its own unmanaged App Server whenever none answers,
# unless CODEX_SSH_SKIP_APP_SERVER_BOOT=true. On 2026-10-08 it won the ten seconds a Codex
# self-update left without a server, and account switching and the updater could no longer manage
# what ran. On the box only the managed daemon may start it (concierge-bot.service, and Concierge
# when nothing answers: startCodexDaemonWhenAbsent), so every SSH session carries the opt-out.
# The drop-in is checked with sshd -t before a reload; a reload keeps open connections.
if [ "$(uname -s)" = Linux ] && [ -d /etc/ssh/sshd_config.d ] && command -v sshd >/dev/null; then
  dropin=/etc/ssh/sshd_config.d/50-codex-managed-app-server.conf
  wanted='SetEnv CODEX_SSH_SKIP_APP_SERVER_BOOT=true'
  if [ "$(cat "$dropin" 2>/dev/null)" != "$wanted" ]; then
    printf '%s\n' "$wanted" > "$dropin.new"
    mv "$dropin.new" "$dropin"
    if sshd -t; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd
      echo "Installed SSH opt-out of Codex desktop server boot: $dropin"
    else
      rm -f "$dropin"
      echo "sshd rejected $dropin; removed it, the Codex desktop app may still start its own server." >&2
    fi
  fi
fi

# git itself refuses the push too, for every checkout and worktree, whatever runs it.
"$(dirname "$0")/install-git-history-guard.sh" --system
