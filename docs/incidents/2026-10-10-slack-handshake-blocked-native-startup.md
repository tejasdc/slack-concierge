---
failure: A failed TLS handshake to the retired Slack socket held Concierge's startup, so the owner sockets never opened and accepted work waited.
date: 2026-10-10
fix_commits: [3566df7b]
cause_status: confirmed
---

# The retired Slack connection blocked native startup

## What was seen

On October 10 a Slack Socket Mode TLS handshake failed during startup; startup stayed in its `slack_connection` phase,
the owner sockets were absent and accepted work waited (`docs/runbooks/DEPLOYMENT.md`).

## Cause

`bot/src/index.ts` awaited the Slack Socket Mode connection before starting the native request owner. Slack was
deprecated on September 15, but the production composition still made its connection a startup prerequisite.

## Fix

3566df7b starts the native owner independently of the Slack connection attempt; the Slack outcome is retained and logged,
and only the Slack sandbox still waits for its socket. `docs/runbooks/DEPLOYMENT.md` and AGENTS.md record the boundary.

## Acceptance scenario

- **Seed:** Production composition with Slack configured to an endpoint that hangs or fails the TLS handshake.
- **Action:** Start Concierge.
- **Expected:** The owner socket and capture intake are listening and a queued turn is claimed; the Slack failure appears
  only in the log.
- **Replayable offline:** yes (point the Slack URL at a local port that stalls)
