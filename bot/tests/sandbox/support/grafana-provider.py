#!/usr/bin/env python3
"""Run-scoped provider transport fixture; never queries production monitoring."""
import json
import re
import sys
import uuid

initial = json.loads(sys.stdin.readline())
content = initial.get("message", {}).get("content", [])
text = content if isinstance(content, str) else "\n".join(block.get("text", "") for block in content)
args = sys.argv[1:]
session = args[args.index("--resume") + 1] if "--resume" in args else str(uuid.uuid4())
model = args[args.index("--model") + 1] if "--model" in args else "claude-opus-5"
fingerprint = re.search(r"Fingerprint: ([a-f0-9]{16,64})", text)
if fingerprint:
    for required in ["machine-generated Grafana", "bounded, read-only investigation", "Do not modify", "no automatic follow-up"]:
        if required not in text:
            raise SystemExit("machine prompt omitted its bounded scope")
    answer = "TL;DR: Sandbox investigation received " + fingerprint.group(1) + ". No production queries were made."
else:
    answer = "TL;DR: Sandbox Grafana fixture ready."
print(json.dumps(initial), flush=True)
print(json.dumps({"type": "system", "subtype": "init", "model": model, "session_id": session}), flush=True)
print(json.dumps({"type": "result", "is_error": False, "result": answer, "session_id": session, "duration_ms": 125}), flush=True)
