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
#   router-actions.sh channel-id <channel-name>          # prints channel_id
#   router-actions.sh channels-list                       # prints active channels
#
# Posting verbs return JSON with the exact message ts and Slack permalink.
# React returns JSON identifying the exact message and both reaction outcomes.
# All posting verbs shell into the SAME router-post.ts script under
# /root/workspace/slack-concierge/bot/scripts/, so all message-visible text
# goes through the same `toMrkdwn` converter the bot itself uses. Text that
# Slack would split is uploaded once as the exact `routed-request.txt` body,
# with a converted short comment. Any format regression (** headers, [x](y)
# links, etc.) is corrected in one place.
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/root/.bun/bin:/root/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

STATE_DB=${CONCIERGE_STATE_DB:-${CONCIERGE_STATE_DIR:-/root/.local/state/concierge}/state.db}
export CONCIERGE_STATE_DB="$STATE_DB"
BOT_DIR=${CONCIERGE_ROUTER_BOT_DIR:-/root/workspace/slack-concierge/bot}

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
    exec bun run "$BOT_DIR/scripts/router-sessions.ts" "$@"
    ;;
  work)
    shift
    exec bun run "$BOT_DIR/scripts/router-request-client.ts" "$@"
    ;;
  threads)
    shift
    exec bun run "$BOT_DIR/scripts/router-threads.ts" "$@"
    ;;
  channel-id)
    sqlite3 "$STATE_DB" "SELECT slack_channel_id FROM channels WHERE slack_channel_name='${2//\'/}'"
    ;;
  channels-list)
    sqlite3 -header "$STATE_DB" "SELECT slack_channel_name, slack_channel_id FROM channels WHERE slack_channel_id IS NOT NULL AND mode != 'silent' ORDER BY slack_channel_name"
    ;;
  post|resume|upload|audit|thread-of|resolve-upload|permalink|trigger)
    # Shell out to bun so text runs through toMrkdwn.
    exec bun run "$BOT_DIR/scripts/router-post.ts" --action "$@"
    ;;
  help|--help)
    exec bun run "$BOT_DIR/scripts/router-post.ts" --help
    ;;
  react)
    # Project both non-atomic writes and report their exact outcomes in one receipt.
    exec bun run "$BOT_DIR/scripts/router-react.ts" "${2:-}" "${3:-}" "${4:-}"
    ;;
  todo-add)
    shift
    exec bun run "$BOT_DIR/scripts/router-todo.ts" "$@"
    ;;
  test-capture)
    # An agent testing a real delivery path, recorded as that agent, never as Tejas.
    shift
    exec bun run "$BOT_DIR/scripts/agent-test-capture.ts" "$@"
    ;;
  list-add)
    echo "list-add is retired: use todo-add so notes/TODOS.md remains authoritative" >&2
    exit 2
    ;;
  *)
    echo "usage: $0 {wait|post|resume|upload|audit|thread-of|resolve-upload|permalink|trigger|threads|sessions|react|todo-add|test-capture|channel-id|channels-list|help} <args>" >&2
    exit 2
    ;;
esac
