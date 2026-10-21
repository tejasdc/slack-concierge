---
failure: Running a session search while an update was waiting to drain crashed Concierge, twice in half an hour.
date: 2026-10-07
fix_commits: [a4ee353a]
cause_status: confirmed
---

# Searching sessions crashed Concierge during an update

## What was seen

Concierge exited at 05:47Z and again at 06:14Z on 2026-10-07 while an update was waiting for his sessions to
finish. The failure notice said the service had "stopped after repeated failures" even though systemd was
restarting it, so the crash read as a permanent stop.

## Cause

Confirmed from the commit. Session search (and the router index rebuild) looped over a statement with
`iterate()` and broke out early. That left the statement open, which pinned the connection's read snapshot of
the ledger. When the waiting deployment's drain check committed from another process, every later write on the
pinned connection failed immediately with "database is locked". The first failing write was the turn queue's
`wake()` claim, called from a finished turn's promise callback; a throw there is an unhandled rejection, which
ends the whole process. A second contributor: `service-failure-notice.sh` could not distinguish a crash that
systemd would restart from a stopped service.

## Fix

- a4ee353a adds `bot/src/ledger-rows.ts` (`ledgerRows()`), which finalizes its statement however the loop ends;
  search and the router index rebuild use it, and `bot/scripts/retry-architecture-lint.ts` refuses a bare
  `.iterate(` anywhere else so the release build fails on a recurrence.
- The turn queue (`session-turn-queue.ts`) treats a throwing claim as "nothing claimed", logs
  `session_turn_claim_failed`, and retries within 2-60 s, so a locked ledger can no longer become an unhandled
  rejection.
- The failure notice now says the service crashed and is restarting when systemd is restarting it.

## Acceptance scenario

- **Seed:** a ledger with enough sessions that a search loop exits early; a second process (the deployment
  drain check) that commits to the ledger while the search statement is still open.
- **Action:** run a session search that breaks out of its row loop, then have the other process commit, then
  let a turn finish so the queue wakes and claims.
- **Expected:** the statement is finalized when the loop ends, later writes succeed, the process stays up;
  if a claim does throw, `session_turn_claim_failed` is logged and the queue claims again within a minute.
  The release lint fails if a new `.iterate(` is added outside `ledger-rows.ts`.
- **Replayable offline:** yes (scratch SQLite database with two connections; no provider needed)
