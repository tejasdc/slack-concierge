---
failure: While the Mac did not answer the server, each of the Mac's reply notifications made the server wait 20 seconds for the reply and that wait was reported as owner slowness, reopening the same degradation incident 15 times.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# A silent Mac was reported as a slow Concierge owner

## What was seen

Work-flow supervisor incident 474d66cd reopened for the fifteenth time at 07:14Z on 2026-11-07
with reason `owner_slow_reads`: six requests of 20,001 ms each, all finishing within 4 ms of each
other at 07:13:39Z, with no event-loop lag, under a millisecond of ledger time, zero awaited time,
and a 16-byte accepted answer. The same six-request batch recurred at 06:56Z and 07:04Z. The
route was logged only as `POST /sessions/v1/:unknown`. The Mac had been unreachable from the
server since 12:18Z the previous day (2,532 unreachable errors), while the Mac's own calls still
arrived.

## Cause

The Mac notifies the server when a reply to the server's request is ready. The server's handler
for that notification reads the reply back from the Mac inside the same request, through the
peer client's one transport method, whose fetch times out after the 20-second owner read limit.
That fetch was not wrapped as a deliberate outside wait, so the whole 20 seconds counted as owner
time in the request record the supervisor judges. The 2026-10-13 and 2026-10-24 records
established that every wait for another machine inside an owner request is awaited time; the
peer transport was the remaining unwrapped one. The peer routes also had no request label, so
the batch could not be attributed from the journal.

## Fix

The peer client's transport records its fetch and body read as awaited time
(`awaitingOutside` in `bot/src/session-peers.ts`); outside an owner request the wrapper is a
no-op. The owner request labeler names the peer, handoff, pause, focus-hold, agent-report,
observation and feature-request routes, so a slow one is attributed by route instead of
`:unknown`.

## Acceptance scenario

- **Seed:** The Mac peer is configured but does not answer connections; a request to it has a
  reply row the Mac notifies about.
- **Action:** The Mac sends `POST /sessions/v1/peers/requests/<id>/notify` to the server.
- **Expected:** The request record shows `awaited_ms` close to `duration_ms`, the route label is
  `POST /sessions/v1/peers/requests/:id/notify`, and the supervisor's slow-request judgement
  (`duration_ms - awaited_ms`) stays under its 2-second line.
- **Replayable offline:** yes, with a peer client pointed at an address that never answers.
