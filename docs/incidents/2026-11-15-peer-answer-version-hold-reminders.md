---
failure: Repeated peer version-hold notices obscured a request that later had an exact ready receipt.
date: 2026-11-15
fix_commits: []
cause_status: best-explanation
---

# Peer answer guarantee notices repeated after recovery

## What was seen

The retained request `ed4dd1b9-51bf-4b4c-8d1e-db8ad76f72fb` had three separate version-hold notices. Its later exact peer status reported guarantee version 1, accepted version 1, a ready answer task, and zero unresolved obligations. The original request remained admitted with its progress and watch linkage; no replacement request was needed. The failed historical response bytes were not retained, so the specific transport trigger is unknown.

## Cause

Confirmed source defects allowed `notified()` and scheduled reconciliation to read the same request concurrently, and hold recovery read status twice. A successful response that could not be parsed was collapsed to `null`, then treated as a missing-version peer response. The hold reminder used a random event ID, so later observations could add notices despite an existing typed notice. The incident's exact historical read sequence and response bytes are unavailable; these source paths are the best explanation, not proof of which path produced each notice.

## Fix

Serialize reconciliation by original request ID. Validate each successful status against its exact request and retained target; malformed, incomplete or contradictory status is recorded as bounded metadata without replacing valid evidence. A later exact ready status completes the hold in the same read and retains its recovery time. Reuse the typed version-hold event identity, including when the existing event has a historical random ID. Keep the original accepted input, request, progress, watch and settlement proof; never replay the request to obtain a new receipt.

## Acceptance scenario

- **Seed:** An open version-held request with exact target identity, a prior valid status and three retained `peer answer guarantee unconfirmed` events using historical random IDs.
- **Action:** Overlap two notifications while the peer first returns malformed successful JSON, then returns one exact v1 ready status.
- **Expected:** The malformed read does not release the hold, overwrite prior proof or add a notice. The next read releases the hold, records readiness and recovery time, performs no second GET or POST, and preserves the three historical event IDs and original request identity.
- **Replayable offline:** yes (the native fixture uses a scratch ledger and a controlled `PeerClient` HTTP boundary; it contacts no provider or Mac).
