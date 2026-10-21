---
failure: Routine server or Mac updates filed a repair notice saying the other machine's Concierge was not running.
date: 2026-10-16
fix_commits: [3b801428]
cause_status: confirmed
---

# Routine updates triggered false alerts that the other Concierge was down

## What was seen

Two ordinary server updates in one night (2026-10-16 03:54 and 05:16 UTC) each filed a "Concierge is not
running" repair notice about the peer. Nothing was down; the peer's Concierge was only restarting for the
update, which takes about two seconds.

## Cause

`PeerClient.request` in `bot/src/session-peers.ts` treats a refused connection (`ConnectionRefused` /
`ECONNREFUSED`) as "the machine is awake but its Concierge is not running" and passed `announce:true` to
`recordRetryFailure` for the `peer:<name>` breaker. An update restarts Concierge and every request in flight
is refused together: fifteen refusals in under four seconds exhausted the breaker's attempt budget, and
exhaustion with `announce:true` files the notice. A single burst was enough, so duration of the outage was
never part of the decision.

## Fix

3b801428: the client remembers when the peer first started refusing (`refusedSince`, cleared by any answered
request) and passes `announce` only after `PEER_DOWN_ANNOUNCE_AFTER_MS` (3 minutes) of continuous refusal. The
breaker still backs off and logs immediately. Three minutes is longer than a restart plus start-up and short
enough that a real outage (the Mac's two hours on 2026-10-10) still reaches the repair agent. A window on the
peer client was chosen over changing the shared breaker's attempt counting, which every other dependency uses.
`docs/runbooks/PEER-INSTANCES.md` was updated to say so.

## Acceptance scenario

- **Seed:** A peer instance (or stub) that answers requests, with the peer breaker at zero failures.
- **Action:** Stop the peer's listener for about 5 seconds while 15 requests are in flight, then restart it.
- **Expected:** The requests are refused and the breaker backs off, but no `retry_stopped` repair notice is
  filed. Keeping the listener down for more than 3 minutes does file exactly one notice.
- **Replayable offline:** yes (a stub peer on a local port plus a controllable clock; no real Mac needed)
