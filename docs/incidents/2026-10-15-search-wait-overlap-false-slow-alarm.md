---
failure: Session searches that waited on Thinkering to prove several archived conversations at once were reported as Concierge itself being slow, opening a false health incident.
date: 2026-10-15
fix_commits: [4be1ccb0]
cause_status: confirmed
---

# Overlapping archive proofs during search were counted as owner slowness

## What was seen

On 2026-10-15 the work-flow supervisor opened degradation incident fa772103 ("Concierge is slowing
down"). remote-box's Concierge monitor read 26 s and 11 s of owner slowness from two session
searches. In that window the owner's event loop was blocked for under 4 s; the searches were waiting
on Thinkering, which spent 29 s copying and hashing the Inbox router's 383 MB transcript for one
archive retention proof (a second search shared it for 11 s). Concierge had logged only 2.9 s and
0.2 s as `awaited_ms` for those searches.

## Cause

`awaitingOutside` in `bot/src/storage-observation.ts` records time a request spends waiting outside
the owner, which the monitor subtracts from wall time. It counted only one wait at a time: if a wait
was already pending (`scope.awaiting > 0`), a new one ran unrecorded. Nesting was the intended case
for that rule, but a search fans its archive retention proofs out to Thinkering in parallel. The
first sibling to start, a short 2.9 s proof, was recorded; the 29 s proof beside it was not, so its
time was charged to the owner. This is a different gap from the earlier one, where some outside
waits were not recorded at all (see
[2026-10-13-owner-slow-alarm-from-awaited-waits.md](2026-10-13-owner-slow-alarm-from-awaited-waits.md)).

## Fix

4be1ccb0 counts the union of overlapping waits: the first wait of an overlap stamps
`awaitingSince`, the last one to end adds the span, nested waits still count once, and a wait still
pending when the operation finishes adds its share up to that point. `awaited_ms` can never exceed
wall time. `bot/scripts/storage-observation-check.ts` asserts it: three overlapping waits (20, 120 and
nested 60 ms) followed by a 40 ms wait must record at least 150 ms. The old counting recorded 60 ms.
`docs/architecture/SESSION-OWNER.md` was updated.

## Acceptance scenario

- **Seed:** An owner request scope that runs several `awaitingOutside` waits at once, e.g. a search
  whose archive proofs take 3 s and 29 s in parallel against a slow stub capability host.
- **Action:** Run the search and read its `owner_request_completed`/`owner_request_slow` line.
- **Expected:** `awaited_ms` is about 29 s (the union), `duration_ms - awaited_ms` is small, and no
  owner-slowness incident is raised; the loop-lag signal stays quiet.
- **Replayable offline:** yes (the storage-observation check reproduces it with timers; a stub
  capability socket reproduces the search path)
