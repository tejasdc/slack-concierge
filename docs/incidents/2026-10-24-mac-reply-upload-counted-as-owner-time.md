---
failure: The server's health watch opened a "Concierge is slow" incident when Concierge was only waiting for a Mac agent's reply with two screenshots to finish uploading over the Tailscale relay.
date: 2026-10-24
fix_commits: []
cause_status: confirmed
---

# A Mac agent's screenshot upload was reported as Concierge being slow

## What was seen

Work-flow supervisor incident a8216a4c opened "degradation: owner_slow_reads" at 18:10-18:12Z on
2026-10-24 on one request: `POST /sessions/v1/peers/requests/<id>/replies` (labelled
`POST /sessions/v1/:unknown`, so counted under the monitor's "other" routes), 13,761 ms of wall time
with `awaited_ms` 0, status 202, a 93-byte answer. The owner was responsive throughout: 68 ms of
ledger work in 116 calls, no `owner_event_loop_lag` record (the monitor's `lag_ms` was 0), both read
executors idle, the presentation worker caught up, a 2 ms supervisor ping, and the pause-all and
focus-hold reads during those 14 s answered in 0-1 ms. The request began at 18:09:25.445Z when its
headers arrived and ended at 18:09:39.206Z, 63 ms after `session_peer_reply_recorded` for peer `mac`
request a9e7b09b. The gateway's `foreground_owner_dependency_delayed` line for the same admission
reported 13,949 ms to headers.

The reply was the Mac agent's final answer on the trip-packing acceptance work and carried two PNG
screenshots, 3.64 MB and 3.64 MB as base64 JSON (about 2.7 MB each raw), so the request body was
about 7.3 MB. The Mac (`tejass-m3-max`) was connected through the Tailscale relay `nyc`, not a direct
path. Nine minutes earlier the same Mac session's reply with three smaller files (0.55 MB together)
took 717 ms on the same route; a week of `owner_request_slow` lines on this label shows the same
shape, 250-2,600 ms with `awaited_ms` 0 and tiny answers, each ending as a Mac reply was recorded.

## Cause

The owner's request handler (`handleRequest` in `bot/src/session-owner.ts`) read every POST body with
`await request.json()` outside the `awaitingOutside` scope. The gateway forwards the request as a
stream (`forwardPrivateRequest`), so the owner's `owner_request_started` fires when the headers
arrive and the body read then waits for the Mac's bytes to cross the relay. That wait is time spent on
another machine's upload, not the owner's own time, but it was counted as owner time: `awaited_ms`
stayed 0, the owner wrote `owner_request_slow`, and remote-box's monitor (which subtracts
`awaited_ms` since 2026-10-13) saw a 13.7 s owner request, above its 10 s threshold.

This is the third member of the class recorded in
`2026-10-13-owner-slow-alarm-from-awaited-waits.md` and `2026-10-15-search-wait-overlap-false-slow-alarm.md`:
a deliberate wait for something outside the owner, measured as owner slowness. The earlier fixes
covered the throwaway provider copy and every call over Thinkering's capability socket; the request
body itself was the remaining unwrapped wait.

## Fix

- `bot/src/session-owner.ts`: the body read becomes `await awaitingOutside(()=>request.json())`, so
  the time the body takes to arrive is recorded as `awaited_ms` on the `owner_request_completed` and
  `owner_request_slow` lines and left out of the slow-request judgement and the responsiveness
  watch's slow-request record. `duration_ms` stays wall time. Ledger work after the body arrives
  (recording the reply, uploading its files into attachment custody, expiring questions) remains
  owner time.
- `docs/architecture/SESSION-OWNER.md` names the POST body as awaited time with this evidence.

Not changed, and worth knowing: a 7.3 MB reply body over the relay is within the gateway's 120 s
command deadline and the Mac's own send timeout, so the reply arrived whole and was recorded once; the
Mac's log of the push itself could not be read because the Mac was asleep during this investigation.

## Acceptance scenario

- **Seed:** An owner behind its gateway, with a peer client whose POST body is a readable stream
  that delivers a valid 5 MB JSON reply body over 5 s (chunked, the last byte at 5 s).
- **Action:** Send one `POST /sessions/v1/peers/requests/<id>/replies` for a recorded peer request
  while issuing status reads.
- **Expected:** The request's `owner_request_completed` line shows `awaited_ms` close to 5,000 and
  `duration_ms` close to it; no `owner_request_slow` line and no slow-request record for it; status
  reads answer promptly; the reply is recorded exactly once with its files.
- **Replayable offline:** yes (a stub peer streaming a fixed body; no Mac or Tailscale)
