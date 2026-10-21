---
failure: Agents could not run their marked end-to-end check of the Pebble capture path; every attempt was refused as unauthorized.
date: 2026-10-12
fix_commits: [08cc9130]
cause_status: confirmed
---

# The agent Pebble test entrance was always refused

## What was seen

`router-actions.sh test-capture pebble`, the entrance agents use to prove the Pebble capture path without posing as
Tejas, failed with 401, so agents could not verify that path end to end as the delivery policy requires.

## Cause

`bot/scripts/agent-test-capture.ts` sent the contents of `/etc/concierge/pebble-index.token` as the bearer key. On the
server that file holds only a one-way verifier of the phone's key, not the key, so `capture-ingress.ts` could never
authorize the request.

## Fix

08cc9130 makes the test entrance send the server-held Thinkering capture key, and the Pebble route accepts that key only
when the request carries the `X-Concierge-Agent-Source` header; ordinary Pebble requests still need the phone key, and the
owner still verifies the named input and run before recording an agent capture.

## Acceptance scenario

- **Seed:** Capture ingress with the Pebble verifier and the Thinkering key configured; a live agent run.
- **Action:** Run the test entrance for Pebble from that run; then send the same request without the agent header.
- **Expected:** The first is accepted and recorded as the agent's capture; the second is refused 401.
- **Replayable offline:** yes (scratch ingress with test keys)
