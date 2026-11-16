---
failure: An outside Concierge agent could not test a local Voice Memos capture under its own name.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Outside agent local capture test used an unavailable socket

## What was seen

The marked Voice Memos test in an outside Codex run failed with `ENOENT` before
delivery. Its helper looked for an owner socket inside the isolated runner state.
The marked Send to Inbox test did reach the capture drop-off and returned an
accepted queue receipt; that separate receipt does not prove final Inbox display.

## Cause

The local producer branch of the test helper built a socket path from the
run's state directory. Outside runs reach Concierge through the authenticated
agent-to-owner connection, not a local owner socket in that directory.

## Fix

The helper uses the existing agent-to-owner request client for these local
producer tests. It retains the exact agent input and run in the capture source.

## Acceptance scenario

- **Seed:** An outside Concierge agent has a valid accepted input and run.
- **Action:** Send one marked Voice Memos test through the helper.
- **Expected:** Concierge accepts one capture with agent origin and the exact source pair; the helper returns its receipt without a local socket error.
- **Replayable offline:** yes (an isolated owner and runner connection can exercise the helper).
