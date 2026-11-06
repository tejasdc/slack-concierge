---
failure: A Mac agent's accepted watch-backed partial lost its watch binding at the server, which then closed the open request as unanswered when the Mac turn ended.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Mac watch wait lost at the peer boundary

## What was seen

Request `5b293c9b-ea06-4f24-867f-038fac1b86dd` received a partial reply from Mac agent 315 naming active watch `6d137d669674`. The Mac accepted the reply. Its peer event and status projection omitted the watch ID, and the server's stranded check considered only whether the Mac turn was still running. It therefore inferred an unanswered request when that turn ended.

## Cause

The Mac kept the validated watch binding locally, but the peer reply projection and the server's liveness decision dropped it. A completed turn is insufficient evidence that a watch-backed request has no future wake.

## Fix

The repair carries the retained watch ID through both peer push and pull, and has the Mac report whether this exact request has a live dependency. The server defers unanswered settlement while the Mac reports that dependency. A watch observation or expiry changes the status fingerprint and prompts reconciliation. The same event ID remains the deduplication key; a late final can still supersede an inferred unanswered result.

While the server and Mac run different revisions, a peer status that omits the dependency answer cannot justify closing a request with a partial reply. The server holds it until the Mac reports that answer; a request with no partial still follows the existing closure rule.

## Acceptance scenario

- **Seed:** An accepted Mac partial names a live watch for an open cross-peer request.
- **Action:** The Mac turn ends; the watch then fires or expires and wakes the Mac agent to reply.
- **Expected:** The server retains the partial and leaves the request pending while the watch is live, then records one final event under the original request ID. A request with no live dependency still follows the unanswered path.
- Replayable offline: no. The repository disables agent-run ledger tests; the installed peer path is the acceptance entrance.
