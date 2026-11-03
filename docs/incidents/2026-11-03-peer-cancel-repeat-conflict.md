---
failure: Reconciliation resent older peer cancellations after the peer had already retained a cancellation instruction or the origin had already received a final answer.
date: 2026-11-03
fix_commits: [a8a420ad]
cause_status: confirmed
---

# Repeated peer cancellation conflicts after the hold repair

## What was seen

After the November 3 cancellation repair reached both machines, server reconciliation repeatedly logged `session_peer_cancel_unsent` for four canceled Mac requests with `Idempotency conflict: accepted action payload changed.` A fifth request returned `Unknown session request.` The retries recurred on ordinary reconciliation wakes.

## Cause

The new origin reconciliation revisited historical canceled requests whose remote acceptance was recorded but no cancellation acknowledgment had been kept. Four peers had already retained `canceled:<requestId>` instructions. Re-entering `canceledByOrigin` tried to retain the same instruction with a changed payload, which the action idempotency contract correctly refused. The fifth peer explicitly returned `Unknown session request.` for its old delivery. The origin's received final event was its own cancellation notice, not a peer answer; it cannot prove the peer stopped work.

## Fix

The peer treats an already retained cancellation instruction as evidence that it must not enqueue another one. It still withdraws a queued target in the same transaction on every call, so a historical held target can be reconciled. The origin continues sending cancellation even after its own final notice is delivered. Only the peer's acknowledgment or its explicit 404 that the exact delivery does not exist ends the retry.

## Acceptance scenario

- **Seed:** cancel a peer request and retain its worker cancellation instruction; separately retain a canceled origin request whose own final cancellation notice was received and whose peer delivery has aged out.
- **Action:** repeat origin cancellation after an update and run reconciliation.
- **Expected:** the first target remains terminal, the existing instruction is unchanged, and the peer acknowledges the repeat. The origin's final notice never suppresses a necessary peer cancellation. The second request stops retrying only after the peer explicitly reports its delivery absent. The original Mac session 75 still has zero pending work.
- **Live check:** inspect the five affected request IDs after installation for no further `session_peer_cancel_unsent` event.
