#!/usr/bin/env bash
# Router action helpers. Router agent calls these to post/react/add-list-item.
# Usage:
#   router-actions.sh post <channel-name> <text>
#   router-actions.sh post <channel-name> --file <path> [--file <path> ...] -- <text>
#   router-actions.sh react <channel-id> <message-ts> <emoji-name>
#   router-actions.sh list-add <channel-name> <item-text>
#   router-actions.sh channel-id <channel-name>          # prints channel_id
#   router-actions.sh channels-list                       # prints all channels
#
# `post` and `react` shell into TypeScript scripts under
# /root/workspace/slack-concierge/bot/scripts/, so ALL outbound text goes
# through the same `toMrkdwn` converter the bot itself uses. Any format
# regression (** headers, [x](y) links, etc.) is corrected in one place.
set -euo pipefail
export PATH="/root/.bun/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

CONFIG=/root/.config/concierge/slack.toml
STATE_DB=/root/.local/state/concierge/state.db
BOT_DIR=/root/workspace/slack-concierge/bot

BOT=$(python3 -c "import re;print(re.search(r'bot_token\s*=\s*\"([^\"]+)\"', open('$CONFIG').read()).group(1))")

case "${1:-}" in
  channel-id)
    sqlite3 "$STATE_DB" "SELECT slack_channel_id FROM channels WHERE slack_channel_name='${2//\'/}'"
    ;;
  channels-list)
    sqlite3 -header "$STATE_DB" "SELECT slack_channel_name, slack_channel_id FROM channels WHERE slack_channel_id IS NOT NULL ORDER BY slack_channel_name"
    ;;
  post)
    # Shell out to bun so text runs through toMrkdwn.
    shift
    exec bun run "$BOT_DIR/scripts/router-post.ts" "$@"
    ;;
  react)
    # Atomic: add outcome emoji AND remove in-progress hourglass.
    exec bun run "$BOT_DIR/scripts/router-react.ts" "$2" "$3" "$4"
    ;;
  list-add)
    CH_ID=$(sqlite3 "$STATE_DB" "SELECT slack_channel_id FROM channels WHERE slack_channel_name='${2//\'/}'")
    LIST_ID=$(sqlite3 "$STATE_DB" "SELECT list_id FROM channels WHERE slack_channel_id='$CH_ID'")
    TITLE_COL=$(sqlite3 "$STATE_DB" "SELECT list_title_column_id FROM channels WHERE slack_channel_id='$CH_ID'")
    if [ -z "$LIST_ID" ] || [ -z "$TITLE_COL" ]; then
      echo "no list configured for #$2 — post as message instead" >&2; exit 2
    fi
    curl -sS -X POST 'https://slack.com/api/slackLists.items.create' \
      -H "Authorization: Bearer $BOT" \
      -H 'Content-Type: application/json' \
      --data "$(python3 -c "import json,sys; print(json.dumps({'list_id':'$LIST_ID','initial_fields':[{'column_id':'$TITLE_COL','value':sys.argv[1]}]}))" "$3")"
    ;;
  *)
    echo "usage: $0 {post|react|list-add|channel-id|channels-list} <args>" >&2
    exit 2
    ;;
esac
