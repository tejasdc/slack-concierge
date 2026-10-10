#!/usr/bin/env bash
# Router action helpers. Router agent calls these to post/react/capture todos.
# Usage:
#   Routed post/resume/upload require --source-channel <input-channel> --source-ts <input-ts>.
#   Add --defer or --after <turn-id>,<channel-id>,<root-ts> only for explicit waiting.
#   router-actions.sh post <channel-name> <source-flags> -- <text>
#   router-actions.sh post <channel-name> --file <path> [--file <path> ...] -- <text>
#   router-actions.sh resume <channel> <thread-ts> [--file <path> ...] -- <text>
#   router-actions.sh upload <channel> <thread-ts> --file <path> [...] [-- <text>]
#   router-actions.sh audit <channel> <trigger-message-ts> -- <text>
#   router-actions.sh thread-of <channel> <message-ts>
#   router-actions.sh resolve-upload <channel> [--thread <ts>] --file-id <id> [...]
#   router-actions.sh permalink <channel> <message-ts>
#   router-actions.sh trigger <turn-id>
#   router-actions.sh threads search [<channel>] --before-ts <message-ts> [--exclude-channel <channel> --exclude-root-ts <root>] [--limit <1..10>] -- <concept...>
#   router-actions.sh threads context <channel> <root-ts> --before-ts <message-ts> [--limit <1..20>]
#   router-actions.sh threads stats
#   router-actions.sh sessions <search|context|ask|reply|get> <args>
#   router-actions.sh wait --pid <pid> [--pid <pid> ...] [--timeout <30s|5m|2h>]
#   router-actions.sh react <channel-id> <message-ts> <emoji-name>
#   router-actions.sh todo-add <channel-name> <source-channel-id> <source-message-ts> -- <item-text>
#   router-actions.sh test-capture --path <path> --source-input <id> --source-run <id> [--reply-to <concierge:N>] -- <text>
#   router-actions.sh messages [--with <number, address or chat name>] [--q <words>] [--days <n>] [--limit <n>]   # Mac only; codes withheld
#   router-actions.sh channel-id <channel-name>          # prints channel_id
#   router-actions.sh channels-list                       # prints active channels
#
# Posting verbs return JSON with the exact message ts and Slack permalink.
# React returns JSON identifying the exact message and both reaction outcomes.
# All posting verbs shell into the SAME router-post.ts script under
# the installed release's control/bot/scripts/, so all message-visible text
# goes through the same `toMrkdwn` converter the bot itself uses. Text that
# Slack would split is uploaded once as the exact `routed-request.txt` body,
# with a converted short comment. Any format regression (** headers, [x](y)
# links, etc.) is corrected in one place.
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/root/.bun/bin:/root/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Concierge's own records: the Mac keeps them where its launchd job does, the server under /root.
# Sessions Concierge starts set CONCIERGE_STATE_DIR; a plain terminal does not, so the default must
# be this machine's (the capability-map check found `project status` failing in a Mac terminal).
if [ "$(uname -s)" = Darwin ]; then DEFAULT_STATE_DIR="$HOME/Library/Application Support/concierge"; else DEFAULT_STATE_DIR=/root/.local/state/concierge; fi
STATE_DB=${CONCIERGE_STATE_DB:-${CONCIERGE_STATE_DIR:-$DEFAULT_STATE_DIR}/state.db}
export CONCIERGE_STATE_DB="$STATE_DB"
if [ "$(uname -s)" = Darwin ]; then
  BOT_DIR=${CONCIERGE_ROUTER_BOT_DIR:-$HOME/workspace/slack-concierge/bot}
else
  BOT_DIR=${CONCIERGE_ROUTER_BOT_DIR:-/var/lib/slack-concierge-deployment/current/control/bot}
fi
ROUTER_SUFFIX=js
if [ ! -f "$BOT_DIR/scripts/router-sessions.js" ]; then ROUTER_SUFFIX=ts; fi

case "${1:-}" in
  wait)
    shift
    pids=()
    timeout_seconds=0
    while (($#)); do
      case "$1" in
        --pid)
          [[ ${2:-} =~ ^[1-9][0-9]*$ ]] || { echo "wait: --pid requires a positive process ID" >&2; exit 2; }
          pids+=("$2")
          shift 2
          ;;
        --timeout)
          [[ ${2:-} =~ ^([1-9][0-9]*)([smh]?)$ ]] || { echo "wait: --timeout requires a duration such as 30s, 5m, or 2h" >&2; exit 2; }
          timeout_seconds=${BASH_REMATCH[1]}
          case "${BASH_REMATCH[2]}" in m) timeout_seconds=$((timeout_seconds * 60));; h) timeout_seconds=$((timeout_seconds * 3600));; esac
          shift 2
          ;;
        *) echo "wait: unknown option $1" >&2; exit 2 ;;
      esac
    done
    ((${#pids[@]})) || { echo "wait: at least one --pid is required" >&2; exit 2; }
    deadline=$((SECONDS + timeout_seconds))
    while :; do
      alive=()
      for pid in "${pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
          state=$(ps -o stat= -p "$pid" 2>/dev/null || true)
          [[ "$state" == Z* ]] || alive+=("$pid")
        fi
      done
      ((${#alive[@]})) || { echo "exited: ${pids[*]}"; exit 0; }
      if ((timeout_seconds > 0 && SECONDS >= deadline)); then
        echo "timed out; still running: ${alive[*]}" >&2
        exit 124
      fi
      sleep 1
    done
    ;;
  sessions)
    shift
    # A new outbound request belongs to the current session owner. Long-running agents keep
    # their pinned hooks, but creation must see today's allowance choice after an update.
    if [ "$(uname -s)" != Darwin ] && [ "${1:-}" = ask ]; then
      CURRENT_BOT_DIR=/var/lib/slack-concierge-deployment/current/control/bot
      if [ -f "$CURRENT_BOT_DIR/scripts/router-sessions.js" ]; then
        exec bun run "$CURRENT_BOT_DIR/scripts/router-sessions.js" "$@"
      fi
    fi
    exec bun run "$BOT_DIR/scripts/router-sessions.$ROUTER_SUFFIX" "$@"
    ;;
  external)
    shift
    exec bun run "$BOT_DIR/scripts/router-external.$ROUTER_SUFFIX" "$@"
    ;;
  projects)
    shift
    exec bun run "$BOT_DIR/scripts/router-projects.$ROUTER_SUFFIX" "$@"
    ;;
  work)
    shift
    exec bun run "$BOT_DIR/scripts/router-request-client.$ROUTER_SUFFIX" "$@"
    ;;
  threads)
    shift
    exec bun run "$BOT_DIR/scripts/router-threads.$ROUTER_SUFFIX" "$@"
    ;;
  channel-id)
    sqlite3 "$STATE_DB" "SELECT slack_channel_id FROM channels WHERE slack_channel_name='${2//\'/}'"
    ;;
  channels-list)
    sqlite3 -header "$STATE_DB" "SELECT slack_channel_name, slack_channel_id FROM channels WHERE slack_channel_id IS NOT NULL AND mode != 'silent' ORDER BY slack_channel_name"
    ;;
  post|resume|upload|audit|thread-of|resolve-upload|permalink|trigger)
    # Shell out to bun so text runs through toMrkdwn.
    exec bun run "$BOT_DIR/scripts/router-post.$ROUTER_SUFFIX" --action "$@"
    ;;
  help|--help)
    exec bun run "$BOT_DIR/scripts/router-post.$ROUTER_SUFFIX" --help
    ;;
  react)
    # Project both non-atomic writes and report their exact outcomes in one receipt.
    exec bun run "$BOT_DIR/scripts/router-react.$ROUTER_SUFFIX" "${2:-}" "${3:-}" "${4:-}"
    ;;
  todo-add)
    shift
    exec bun run "$BOT_DIR/scripts/router-todo.$ROUTER_SUFFIX" "$@"
    ;;
  test-capture)
    # An agent testing a real delivery path, recorded as that agent, never as Tejas.
    shift
    exec bun run "$BOT_DIR/scripts/agent-test-capture.$ROUTER_SUFFIX" "$@"
    ;;
  messages)
    # His texts on the Mac, with login codes, reset texts and sign-in links withheld; agents may
    # not open the Messages database themselves.
    shift
    exec bun run "$BOT_DIR/scripts/messages-read.$ROUTER_SUFFIX" "$@"
    ;;
  list-add)
    echo "list-add is retired: use todo-add so notes/TODOS.md remains authoritative" >&2
    exit 2
    ;;
  *)
    echo "usage: $0 {wait|post|resume|upload|audit|thread-of|resolve-upload|permalink|trigger|threads|sessions|external|projects|react|todo-add|test-capture|messages|channel-id|channels-list|help} <args>" >&2
    exit 2
    ;;
esac
