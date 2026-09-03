#!/usr/bin/env bash
# Sandbox-only Claude stream-json stand-in for steering acknowledgement
# acceptance. It deliberately echoes the steering user event without an
# isReplay field, matching the provider contract that Concierge must accept.
set -euo pipefail

IFS= read -r initial_message
printf '%s' "$initial_message" | python3 -c 'import json,sys; value=json.load(sys.stdin); value["isReplay"]=True; print(json.dumps(value))'
printf '%s\n' '{"type":"system","subtype":"init","session_id":"11111111-1111-4111-8111-111111111111"}'

IFS= read -r interrupt_request
request_id="$(printf '%s' "$interrupt_request" | python3 -c 'import json,sys; print(json.load(sys.stdin)["request_id"])')"
printf '%s\n' "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"$request_id\"}}"
if [[ "$request_id" == concierge_stop_* ]]; then
  exit 0
fi

IFS= read -r steering_message
printf '%s\n' "$steering_message"
printf '%s' "$steering_message" | python3 -c 'import json,re,sys; value=json.load(sys.stdin); text="\n".join(block.get("text", "") for block in value["message"]["content"] if block.get("type")=="text"); marker=re.search(r"SANDBOX_CLAUDE_STEERING_ACK_[A-Z0-9]+", text).group(0); print(json.dumps({"type":"result","is_error":False,"result":f"TL;DR: {marker} steering accepted.","session_id":"11111111-1111-4111-8111-111111111111","duration_ms":125}))'
