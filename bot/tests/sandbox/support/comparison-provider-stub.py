#!/usr/bin/env python3
"""Sandbox-only Claude stream-json stand-in for attachment comparison acceptance."""

import json
import pathlib
import re
import sys
import uuid


initial = json.loads(sys.stdin.readline())
content = initial.get("message", {}).get("content", [])
text = content if isinstance(content, str) else "\n".join(
    block.get("text", "") for block in content if block.get("type") == "text"
)
marker_match = re.search(r"SANDBOX_COMPARISON_[A-Z0-9]+", text)
file_id_match = re.search(r"slack_file_id=(F[A-Z0-9]+)", text)
path_match = re.search(r"local_path:\s*(\S+)", text)
if not marker_match or not file_id_match or not path_match:
    raise SystemExit("comparison input omitted its marker, Slack file identity, or local path")

marker = marker_match.group(0)
file_id = file_id_match.group(1)
attachment_text = pathlib.Path(path_match.group(1)).read_text(encoding="utf-8")
attachment_marker = f"ATTACHMENT_{marker}"
if attachment_marker not in attachment_text:
    raise SystemExit("comparison provider could not read the expected attachment contents")
session_id = str(uuid.uuid4())
arguments = sys.argv[1:]
model = arguments[arguments.index("--model") + 1] if "--model" in arguments else "claude-fable-5-1"

print(json.dumps(initial), flush=True)
print(json.dumps({
    "type": "system",
    "subtype": "init",
    "model": model,
    "session_id": session_id,
}), flush=True)
print(json.dumps({
    "type": "result",
    "is_error": False,
    "result": f"TL;DR: {marker} faithfully replayed {file_id} and {attachment_marker}.",
    "session_id": session_id,
    "duration_ms": 125,
}), flush=True)
