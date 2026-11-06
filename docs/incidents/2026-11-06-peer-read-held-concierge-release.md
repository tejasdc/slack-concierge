---
failure: A sleeping Mac held Concierge's server restart while peer status reads timed out.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# A peer read held Concierge's server restart

## What was seen

In the 02:15 UTC release, Concierge's foreground gateway became unavailable at
02:15:05.873. The request server closed in 65 milliseconds, but session
communication took 15.8 seconds to stop. Six requests to the unreachable Mac
ended at the same boundary.

## Cause

The peer owner awaited its in-flight status reads during shutdown. Their read
deadline, rather than the shutdown work, determined the duration. The exact
peer request records already survived a restart, so waiting for their status
reads added no recovery guarantee.

## Fix

Server shutdown now aborts peer status and reply reads before waiting for
communication workers. It leaves peer admission POSTs and their exact request
identities intact. A new owner reconciles those identities after startup.

## Acceptance scenario

- **Seed:** An open peer request on the server and a Mac status endpoint that accepts a connection but never answers.
- **Action:** Start request status reconciliation, then stop the server peer owner.
- **Expected:** Shutdown finishes promptly without settling or replacing the request; restart can reconcile the original request ID.
- **Replayable offline:** no (the diagnostic used a temporary loopback peer; the current agent-test policy does not authorize a retained fixture).
