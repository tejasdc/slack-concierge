---
failure: Withdrawing a handoff left its suspended successor showing queued work forever.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Withdrawn handoffs still showed queued work

## What was seen

Read-only Mac ledger evidence supplied by the investigating parent showed turns 1128
(session 248, continuation of 1127), 1129 (session 249), and 1130 (session 250)
queued with backoff and next attempt zero. Their sessions were suspended, and incoming
handoffs 8e79c8bc-f267-454a-b5b0-a4f3e23f1a84,
027ded02-cf14-4d04-a384-f63c977319c5, and
ad8ba70a-caf4-41ba-a32e-28ecdfa49e23 were withdrawn.

## Cause

The withdrawal transaction changed the proposal state and suspended its successor,
but did not terminalize waiting turns. Suspension prevented dispatch without ending
the queued projection. The source defect is confirmed; this record does not claim
independent readback of the original Mac rows.

## Fix

The same owner transaction cancels waiting successor turns, retains exact inputs and
provider evidence, clears retry scheduling and records why execution was withdrawn.
Possible prior effects remain uncertain. Running turns keep their existing lifecycle.
Owner startup applies this transition idempotently to historical withdrawn queues.
Continuation admission refuses further execution for withdrawn successors.

## Acceptance scenario

- **Seed:** A proposed or already withdrawn handoff with a successor holding an untouched
  queue turn, a queued continuation, an acknowledged queued retry, and a running turn.
- **Action:** Withdraw the proposal, or run normal startup queue reconciliation.
- **Expected:** The three queued turns become cancelled with the withdrawal reason and
  no retry hold; acknowledged work retains uncertain receipt and provider identity;
  original payloads and turn IDs stay exact. Running work stays running, later continuation
  is refused, and repeating reconciliation creates no new event or execution.
- **Replayable offline:** yes, `cd bot && bun run scripts/held-work-movability-fixture.ts`.

Installed acceptance still requires reading the three original Mac turns after the
normal release and startup; no production ledger mutation is part of the fixture.
