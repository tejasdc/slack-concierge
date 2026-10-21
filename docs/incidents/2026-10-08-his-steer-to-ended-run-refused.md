---
failure: Messages Tejas sent into a busy session were refused and never reached it, because the piece of work they were aimed at had already ended.
date: 2026-10-08
fix_commits: [38b4513e]
cause_status: confirmed
---

# His messages to an orchestrating session were refused

## What was seen

At 2:31 AM on 2026-10-08 two of Tejas's messages to concierge:4168 never reached the session. He reported
"Every single request in the session as failure". The session was an orchestrator starting a new run every
few seconds (~35 runs between 02:02 and 02:38).

## Cause

Confirmed from 38b4513e. A message sent while an agent is working is sent with `delivery:'steer'` pinned to
the run id the app saw (`expectedRunId`). In `session-owner.ts`, if the active run's `native_run_id` no longer
matched, the owner threw `SessionOwnerError('The selected live run changed; input was not steered.', 409)`.
In a session that cycles runs every few seconds the pinned run had usually ended by the time the message
arrived. A steer refused after admission was also marked failed in `session-inputs.ts` ("The selected live
run ended before this input could be steered."), and recovery of an unsent steer refused human messages.

## Fix

38b4513e: a human steer that cannot join its pinned run (run ended, stopping, not steerable, or a fork) is
rewritten to the session's next queued message under the same action id (`asQueued`); a retry of the original
steer matches the stored queued form instead of raising an idempotency conflict. A human steer refused after
admission is re-enqueued via `recoverUnsentSteeredInput` rather than failed. Exact-run delivery that refuses
remains only for service inputs. Rehearsed on a copy of the live state for concierge:4168.

## Acceptance scenario

- **Seed:** a session whose run R1 has just completed and a new run R2 (or none) is active.
- **Action:** Tejas sends a message with `delivery:'steer'`, `expectedRunId:R1`; then the same action id is
  retried.
- **Expected:** both calls return the same accepted input, stored as a queued turn that later runs; no 409, no
  failed receipt. A service input pinned to R1 is still refused.
- **Replayable offline:** yes (scratch ledger and owner socket)
