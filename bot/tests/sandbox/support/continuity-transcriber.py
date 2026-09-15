#!/usr/bin/env python3
"""Gate a known transcript so the sandbox can issue real Stop during preparation."""
import os
import time
from pathlib import Path

assert os.environ.get("CONCIERGE_RUNTIME_PROFILE") == "sandbox"
root = Path(os.environ["CONCIERGE_SANDBOX_EVIDENCE_DIR"])
assert root.is_dir() and not root.is_symlink()
(root / "continuity-transcriber-ready").write_text("ready")
deadline = time.monotonic() + 600
while not (root / "continuity-transcriber-release").exists():
    if time.monotonic() > deadline:
        raise RuntimeError("Sandbox Stop did not release the transcription gate")
    time.sleep(0.1)
print((root / "continuity-transcript.txt").read_text(), end="")
