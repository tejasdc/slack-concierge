---
failure: A momentary database lock on the server made the Mac give up forwarding a finished answer after one try, losing it.
date: 2026-10-08
fix_commits: [1bfe80e7]
cause_status: confirmed
---

# A Mac agent's finished answer was dropped when the server's database was briefly busy

## What was seen

A Mac agent's final answer never reached the server on October 4. A second one on October 8 reached it only because the
origin Concierge later pulled it. Nobody saw an error; the answer was simply missing from the requester's thread.

## Cause

The server's owner request handler (`SessionOwner` error mapping in `bot/src/session-owner.ts`) turned every unexpected
error into HTTP 400. While the server recorded the Mac's reply, SQLite sometimes reported a transient lock
(busy/locked). That became a 400, which the Mac's forwarder reads as a permanent refusal, so it stopped forwarding after
a single attempt. Peers retry 5xx and not 4xx; the owner was reporting a moment as a verdict.

## Fix

1bfe80e7 imports `isTransientDatabaseError` (`bot/src/database-retry.ts`) into the owner's catch block and answers those
errors 503 with code `DATABASE_BUSY`, before the generic 400 mapping. The Mac's existing retry for 503 then redelivers the
same reply. No peer change was needed.

## Acceptance scenario

- **Seed:** A Mac agent request whose final reply is ready to forward; the server ledger held under a writer lock (a
  second connection with an open write transaction) for a few seconds.
- **Action:** The Mac forwards the final reply while the lock is held, then the lock is released.
- **Expected:** The first attempt gets 503 `DATABASE_BUSY`, not 400; the Mac retries; the reply is recorded once on the
  server and returned to the requester without the origin having to pull it.
- **Replayable offline:** yes (two local owners as server and peer, with a test hook that makes the ledger write raise a
  SQLite busy error once; no real Mac needed)
