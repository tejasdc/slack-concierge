#!/usr/bin/env bash
# Sandbox-only claude stand-in for provider-dispatch-failure acceptance.
# While the marker file exists, every turn fails with the exact production
# authentication error; once the marker is removed, the real CLI takes over so
# resumed turns complete. Select it per-run with
#   CONCIERGE_CLAUDE_CODE_EXECUTABLE=<this script>
#   CONCIERGE_SANDBOX_CLAUDE_BROKEN_MARKER=<marker path>
set -euo pipefail

marker="${CONCIERGE_SANDBOX_CLAUDE_BROKEN_MARKER:?CONCIERGE_SANDBOX_CLAUDE_BROKEN_MARKER must name the broken-state marker file}"

if [ ! -e "$marker" ]; then
  exec claude "$@"
fi

# Speak just enough of the stream-json protocol: replay the initial user
# message so the adapter sees it acknowledged, then report the terminal
# authentication failure with no session identity, exactly like the real CLI
# failing before a session exists.
IFS= read -r first_line || true
printf '%s' "$first_line" | python3 -c '
import json, sys
message = json.loads(sys.stdin.read())
message["isReplay"] = True
print(json.dumps(message))
'
printf '%s\n' '{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed"}'
exit 1
