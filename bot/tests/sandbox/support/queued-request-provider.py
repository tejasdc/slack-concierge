#!/usr/bin/env python3
"""Controlled provider boundary for the real Slack dependency-queue case."""
import json
import re
import sys
import uuid
from pathlib import Path

def emit(value):
    print(json.dumps(value), flush=True)

initial = json.loads(sys.stdin.readline())
emit(initial)
arguments = sys.argv[1:]
session = arguments[arguments.index('--resume') + 1] if '--resume' in arguments else str(uuid.uuid4())
emit({'type': 'system', 'subtype': 'init', 'model': 'claude-fable-5', 'session_id': session})
content = initial['message']['content']
text = content if isinstance(content, str) else '\n'.join(block.get('text', '') for block in content)
for path in re.findall(r'^\s*local_path: (.+)$', text, re.MULTILINE):
    file = Path(path)
    if file.name.endswith('.txt') and file.is_file():
        text += '\n' + file.read_text()
marker = re.search(r'SANDBOX_QUEUED_[A-Z0-9_]+', text).group(0)
if '[QUEUE_HOLD]' in text:
    control = json.loads(sys.stdin.readline())
    request_id = control['request_id']
    emit({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': request_id}})
    if request_id.startswith('concierge_stop_'):
        sys.exit(0)
    emit(json.loads(sys.stdin.readline()))
emit({'type': 'result', 'is_error': False, 'result': 'TL;DR: ' + marker + ' completed.',
      'session_id': session, 'duration_ms': 125})
