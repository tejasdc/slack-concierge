#!/usr/bin/env python3
"""Use real Claude, except for the case's explicit quota-exhaustion input."""
import json
import os
import signal
import subprocess
import sys

first = sys.stdin.readline()
initial = json.loads(first)
arguments = sys.argv[1:]
marker = os.environ.get('CONCIERGE_SANDBOX_CLAUDE_BROKEN_MARKER')
if 'SANDBOX_ROUTER_PROVIDER_EXHAUSTED' not in first or not marker or not os.path.exists(marker):
    child = subprocess.Popen(['claude', *arguments], stdin=subprocess.PIPE, text=True)
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda signum, _frame: child.send_signal(signum))
    try:
        child.stdin.write(first)
        child.stdin.flush()
        for line in sys.stdin:
            child.stdin.write(line)
            child.stdin.flush()
        child.stdin.close()
    except BrokenPipeError:
        pass
    sys.exit(child.wait())

model = arguments[arguments.index('--model') + 1] if '--model' in arguments else 'claude-fable-5-1'

def emit(value):
    print(json.dumps(value), flush=True)

def reject(message):
    emit(message)
    emit({'type': 'system', 'subtype': 'init', 'model': model})
    emit({'type': 'rate_limit_event', 'rate_limit_info': {'status': 'rejected'}})
    emit({'type': 'result', 'is_error': True, 'result': 'Usage exhausted', 'duration_ms': 1})

reject(initial)
for line in sys.stdin:
    event = json.loads(line)
    if event.get('type') == 'control_request':
        request = event['request']
        if request.get('subtype') == 'set_model':
            model = request['model']
        emit({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': event['request_id']}})
        emit({'type': 'system', 'subtype': 'init', 'model': model})
    else:
        reject(event)
