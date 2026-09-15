#!/usr/bin/env python3
"""Setup protocol fixture; machine repairs execute the real CLI in owned scratch."""
import json
import os
import re
import sys
import tempfile
import time
import uuid
from pathlib import Path

initial = json.loads(sys.stdin.readline())
content = initial.get("message", {}).get("content", [])
text = content if isinstance(content, str) else "\n".join(block.get("text", "") for block in content)
args = sys.argv[1:]
session = args[args.index("--resume") + 1] if "--resume" in args else str(uuid.uuid4())
model = args[args.index("--model") + 1] if "--model" in args else "claude-opus-5"
fingerprint = re.search(r"Fingerprint: ([a-f0-9]{16,64})", text)
report = re.search(r"Report receipt identity: ([a-f0-9]{64})", text)
if report:
    for required in ["routine in-scope repair", "context-only", "BUG-REPORT-START", "BUG-REPORT-END"]:
        if required not in text:
            raise SystemExit("report prompt omitted authority, identity boundary or full evidence")
    answer = "TL;DR: Sandbox report received in full: " + report.group(1) + "; BUG-REPORT-START and BUG-REPORT-END present. Transport fixture only."
elif fingerprint:
    for required in ["machine-generated Grafana", "routine in-scope repair", "No email or direct messages", "Never force or wait/poll for Concierge rollout"]:
        if required not in text:
            raise SystemExit("machine prompt omitted its authorized scope")
    cwd = Path.cwd().resolve()
    if not str(cwd).startswith("/var/lib/slack-concierge-sandbox/lanes/") or cwd.name != "grafana-repair":
        raise SystemExit("real repair fixture requires the exact run-owned project")
    if (cwd / "hold-for-native-stop").exists():
        print(json.dumps(initial), flush=True)
        print(json.dumps({"type": "system", "subtype": "init", "model": model, "session_id": session}), flush=True)
        time.sleep(300)
        raise SystemExit("native Stop did not stop its owned provider")
    containment = ("This is an isolated acceptance fixture, not a production alert. "
        "Your entire operational environment is the current grafana-repair directory. "
        "Read its AGENTS.md first. Diagnose pressure.py against resource.json, repair it, "
        "run check.py and publish to this directory's existing local Git origin. "
        "Do not inspect the host filesystem, credentials, production services or outside runbooks. "
        "Do not run df/du or network queries. The condition name maps only to this injected local metric fault. "
        "No production repair or deployment is authorized by this sandbox fixture.")
    if "--append-system-prompt" in args:
        args[args.index("--append-system-prompt") + 1] += "\n\n" + containment
    else:
        args = ["--append-system-prompt", containment, *args]
    # Keep the native request, permissions, model and session arguments intact.
    # Only stdin is replayed because setup selection consumed the first line.
    with tempfile.TemporaryFile() as request:
        request.write((json.dumps(initial) + "\n").encode())
        request.seek(0)
        os.dup2(request.fileno(), 0)
        os.execv("/usr/bin/claude", ["claude", *args])
else:
    answer = "TL;DR: Sandbox Grafana fixture ready."
print(json.dumps(initial), flush=True)
print(json.dumps({"type": "system", "subtype": "init", "model": model, "session_id": session}), flush=True)
print(json.dumps({"type": "result", "is_error": False, "result": answer, "session_id": session, "duration_ms": 125}), flush=True)
