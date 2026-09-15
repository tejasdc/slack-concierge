#!/usr/bin/env python3
"""Native-protocol fixture: every turn needs its own explicit Slack finish input."""
import json
import re
import sys
import uuid


def emit(value):
    print(json.dumps(value), flush=True)


def content(event):
    blocks = event.get('message', {}).get('content', '')
    return blocks if isinstance(blocks, str) else '\n'.join(block.get('text', '') for block in blocks)


arguments = sys.argv[1:]
session = arguments[arguments.index('--resume') + 1] if '--resume' in arguments else str(uuid.uuid4())
initial = json.loads(sys.stdin.readline())
emit(initial)
emit({'type': 'system', 'subtype': 'init', 'model': 'claude-fable-5', 'session_id': session})
received = [content(initial)]
emit({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Sandbox session fixture is awaiting its explicit finish input.'}]}})

for line in sys.stdin:
    event = json.loads(line)
    if event.get('type') == 'control_request':
        request_id = event['request_id']
        emit({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': request_id}})
        if request_id.startswith('concierge_stop_'):
            sys.exit(0)
        continue
    if event.get('type') != 'user':
        raise RuntimeError('Unexpected provider fixture event')
    emit(event)
    message = content(event)
    received.append(message)
    if '[SESSION_FINISH]' not in message:
        continue
    all_text = '\n'.join(received)
    markers = list(dict.fromkeys(re.findall(r'SANDBOX_SESSION_COMM_[A-Z0-9_]+', all_text)))
    requests = list(dict.fromkeys(re.findall(r'Session request ([a-f0-9-]+)', all_text)))
    events = re.findall(r'Session (progress|final|overdue) event ([a-f0-9-]+) for request ([a-f0-9-]+)', all_text)
    summary = ['TL;DR: ' + ' '.join(markers) + ' explicit finish received.']
    summary.extend('Observed request ' + request for request in requests)
    summary.extend(f'Observed {kind} event {event_id} for request {request_id}' for kind, event_id, request_id in events)
    if 'ended without a confirmed answer' in all_text:
        summary.append('The recipient turn ended without a confirmed answer; its exact retained output reference was received.')
    emit({'type': 'result', 'is_error': False, 'result': '\n'.join(summary),
          'session_id': session, 'duration_ms': 125})
    break
