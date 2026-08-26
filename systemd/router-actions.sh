#!/usr/bin/env bash
# Router action helpers. Router agent calls these to post/react/capture todos.
# Usage:
#   router-actions.sh post <channel-name> <text>
#   router-actions.sh post <channel-name> --file <path> [--file <path> ...] -- <text>
#   router-actions.sh resume <channel> <thread-ts> [--file <path> ...] -- <text>
#   router-actions.sh upload <channel> <thread-ts> --file <path> [...] [-- <text>]
#   router-actions.sh audit <channel> <trigger-message-ts> -- <text>
#   router-actions.sh thread-of <channel> <message-ts>
#   router-actions.sh resolve-upload <channel> [--thread <ts>] --file-id <id> [...]
#   router-actions.sh permalink <channel> <message-ts>
#   router-actions.sh trigger <turn-id>
#   router-actions.sh react <channel-id> <message-ts> <emoji-name>
#   router-actions.sh todo-add <channel-name> <source-channel-id> <source-message-ts> -- <item-text>
#   router-actions.sh channel-id <channel-name>          # prints channel_id
#   router-actions.sh channels-list                       # prints all channels
#
# Posting verbs return JSON with the exact message ts and Slack permalink.
# All posting verbs shell into the SAME router-post.ts script under
# /root/workspace/slack-concierge/bot/scripts/, so ALL outbound text goes
# through the same `toMrkdwn` converter the bot itself uses. Any format
# regression (** headers, [x](y) links, etc.) is corrected in one place.
set -euo pipefail
export PATH="/root/.bun/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

STATE_DB=${CONCIERGE_STATE_DB:-/root/.local/state/concierge/state.db}
BOT_DIR=${CONCIERGE_ROUTER_BOT_DIR:-/root/workspace/slack-concierge/bot}

case "${1:-}" in
  channel-id)
    sqlite3 "$STATE_DB" "SELECT slack_channel_id FROM channels WHERE slack_channel_name='${2//\'/}'"
    ;;
  channels-list)
    sqlite3 -header "$STATE_DB" "SELECT slack_channel_name, slack_channel_id FROM channels WHERE slack_channel_id IS NOT NULL ORDER BY slack_channel_name"
    ;;
  post|resume|upload|audit|thread-of|resolve-upload|permalink|trigger)
    # Shell out to bun so text runs through toMrkdwn.
    exec bun run "$BOT_DIR/scripts/router-post.ts" --action "$@"
    ;;
  help|--help)
    exec bun run "$BOT_DIR/scripts/router-post.ts" --help
    ;;
  react)
    # Atomic: add outcome emoji AND remove in-progress hourglass.
    exec bun run "$BOT_DIR/scripts/router-react.ts" "$2" "$3" "$4"
    ;;
  todo-add)
    shift
    exec bun run "$BOT_DIR/scripts/router-todo.ts" "$@"
    ;;
  list-add)
    echo "list-add is retired: use todo-add so notes/TODOS.md remains authoritative" >&2
    exit 2
    ;;
  *)
    echo "usage: $0 {post|resume|upload|audit|thread-of|resolve-upload|permalink|trigger|react|todo-add|channel-id|channels-list|help} <args>" >&2
    exit 2
    ;;
esac
