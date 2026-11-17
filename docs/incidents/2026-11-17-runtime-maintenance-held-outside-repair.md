---
failure: An accepted independent outside repair stayed queued behind maintenance of a shared daemon it did not use.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# Shared-runtime maintenance held an independent repair

## What was seen

Source-bound runtime maintenance was waiting for an active shared Codex conversation to finish.
That conversation had finished its product work but still owed notification and closure. Its
already accepted independent outside repair remained queued without provider acknowledgment.
The requester supplied that metadata-only receipt; private dialogue was not read or bypassed.
No input was resent, canceled or recreated. This change addresses queue admission only, not
the separate notification failure or its unfinished obligations.

## Cause

The shared queue/watch predicate collapsed all admission holders into one blanket Codex stop.
It did not distinguish the independent CLI host from the shared App Server being maintained.
A disposable ledger reproduced the defect: the real claim returned no turn for an eligible
outside input under only the retained runtime-maintenance holder.

## Fix

Keep every existing holder and recovery record authoritative. A complete, holder-matched,
source-bound runtime-maintenance record blocks shared-daemon starts but permits genuine Boolean
outside placement through the ordinary queue. Any other holder still blocks outside, including
account/re-home, legacy, unknown and malformed recovery. Restore derives the same scope from
the historical durable row shape without migration. Pause, Stop, archive, usage, retries,
serialization and the protected launch boundary retain their authority.

## State card

- **Entity/writer:** each stable admission holder belongs to its retained operation; the canonical
  Concierge state writer records/releases it. The holder map is a process-local projection.
- **Identity:** existing runner, operation, source input/run, action and required commit remain
  unchanged; releasing one holder cannot release another.
- **Acceptance:** accepted/queued is not provider acknowledgment. A queue claim proves admission
  only; provider execution, notification and request closure require their own evidence.
- **Retained/provisional:** durable recovery rows survive coordinator restart; queued input and
  turn identities are reused. The fixture neither launches a provider nor simulates a reply.
- **Lifetime/readers:** independent CLI runs use the existing protected execution host. Shared
  runtime maintenance continues through the existing restart lock/recovery. Old code safely
  over-blocks the same rows; new code reads their unchanged shape and fails closed on unknowns.
- **Failure trace:** maintenance intent is durable; shared work owes a final effect; the outside
  repair is accepted but held; restart restores the holder; corrected admission selects the
  original outside turn while shared work remains queued. The repair still owns its final effect.
- **Falsification:** real queue and watch, additive holders, exact outside Boolean placement,
  ordinary queue controls and a fresh-process restore of old-shape rows run in the fixture below.

## Acceptance scenario

- **Seed:** disposable native/shared and independent outside queued inputs, one complete retained
  runtime-maintenance holder; repeat with additive activation/re-home/legacy/unknown holders.
- **Action:** claim through the real queue and read its stuck-work watch; then close/reopen the
  disposable ledger with pre-fix durable row shape, including malformed and incomplete recovery.
- **Expected:** only the original eligible outside turn is claimed under maintenance alone;
  shared work remains held. Every additional non-maintenance holder blocks outside, partial
  releases retain other holders, and recovery preserves scope and exact operation custody.
  Non-Boolean outside values never receive the exception. Pause, Stop, archive, usage, retry
  and active-session controls still block it. Existing protected launcher coverage passes.
- **Replayable offline:** yes; run `bun run scripts/codex-outside-admission-fixture.ts` from `bot/`.
  The old predicate fails the original outside claim; the corrected predicate passes. Installed
  provider behavior and notification recovery are separate acceptance, not claimed here.
