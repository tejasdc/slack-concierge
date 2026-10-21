---
failure: The server's health watch opened a "Concierge is slow" incident twice in one day when Concierge was only waiting for side questions and the daily ChatGPT refresh.
date: 2026-10-13
fix_commits: [3c6bcaaa, e54adbed]
cause_status: confirmed
---

# Waiting on another process was reported as Concierge being slow

## What was seen

Work-flow supervisor incident 838dfa4c opened "degradation: owner_slow_reads" at 06:05-06:07Z on 2026-10-13
on five side-question requests (`POST /sessions/v1/sessions/:id/asides`) of 8-11 s each. It reopened at
10:35-10:37Z on one `POST /sessions/v1/sources/refresh`, the daily ChatGPT transcript refresh, at 267 s. In
both cases the owner was responsive: under half a millisecond of ledger work per side question, zero ledger
calls on the refresh, no `owner_event_loop_lag` record, idle read workers and a 3 ms status read.

## Cause

The owner's slow-request judgement (`owner_request_slow`, the responsiveness watch's slow-request record in
`bot/src/session-owner.ts`) used each request's wall time, and remote-box's monitor read the same lines. A
side question holds its response while a throwaway Claude or Codex copy answers; the refresh holds its response
while Thinkering crawls ChatGPT, which was rate-limiting and pausing 15-120 s. Those deliberate waits on
another process were counted as owner time. The first fix covered only the side-question route, so every
other call over Thinkering's capability socket still counted.

## Fix

- 3c6bcaaa: the storage-observation work record gains `awaited_ms`, filled by `awaitingOutside(...)` in
  `bot/src/storage-observation.ts`. The aside route wraps its wait in it; the slow judgement uses
  `duration_ms - awaited_ms` and the slow line reports `awaited_ms`. The aside route gets its own request label.
- e54adbed: the invariant rather than the next route: `SessionCapabilityClient.post` (the one transport method
  to Thinkering's socket) wraps every call in `awaitingOutside`, covering refresh, search, context, history,
  import and capture notes. Nested waits count once (`awaiting` depth on the scope).
- remote-box 31d4614 (outside this repository) makes the monitor subtract `awaited_ms`.
  `docs/architecture/SESSION-OWNER.md` and the wire contract were updated.

## Acceptance scenario

- **Seed:** An owner whose capability socket is a stub that answers after 3 s, and a side-question provider
  stub that answers after 9 s.
- **Action:** Send one `POST /sessions/v1/sources/refresh` and one side question while issuing status reads.
- **Expected:** Both requests' completed lines show `awaited_ms` close to their wall time; no
  `owner_request_slow` line and no slow-request record for them; status reads answer promptly. A nested
  `awaitingOutside` is counted once.
- **Replayable offline:** yes (stub capability socket and provider; no real ChatGPT or Thinkering)
