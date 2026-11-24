---
failure: A burst of session searches that waited on the separate archive reader was reported as Concierge itself degrading, and an investigating agent was started for it.
date: 2026-11-24
fix_commits: []
cause_status: confirmed
---

# Searches queued in the archive reader opened a "Concierge is degrading" incident

## What was seen

At 03:13 UTC on 2026-11-24 the work-flow supervisor opened degradation incident
`6ca7d85f-fc81-4bbe-92ba-11262679096d` with the single reason `owner_slow_reads`: three slow
requests in five minutes, all on the search route, the slowest 4,642 ms. The owner answered its
health probe in 8 ms, the ledger was healthy, no host pressure episode was open, no update was
active, and loop blocking over the five minutes summed to 0.8 s.

## Cause

Between 03:12:25.8 and 03:12:28.4 UTC four `POST /sessions/v1/search` requests arrived, each
returning 100 results (420–456 KB). The owner hands a search's read to the archive reader, a
separate process with one reader for that class, so the requests queued there: the gateway
logged `foreground_read_delayed` with admission waits of 1,641, 2,459 and 2,443 ms, and
`session_search_slow` reported `executor_wait_ms` of 1,655, 2,523 and 2,468 with `owner_ms: 0`.
The owner did one ledger call of under 0.1 ms per request and kept answering other requests.

The owner's call to the reader was the one wait on another process that was not recorded as
awaited, so `owner_request_slow` fired with `awaited_ms: 0` and the supervisor counted the whole
wall time as the owner's own. Every other such wait (peers, Thinkering's capability socket,
runner calls, side questions) already goes through `awaitingOutside`.

## Fix

The search read is awaited through `awaitingOutside`. A search that waits on the reader now
reports that time as awaited; the supervisor counts it among requests that only waited on another
service. `session_search_slow` and `foreground_read_delayed` still report a slow or queued search
with its phases. Meaning search, which the owner runs itself, stays owner time.

Not changed: the archive lane still has one reader, so a burst of large searches still queues.
`session_search_executor_fallback` with reason `queued` remains the signal for giving that lane
its own reader; none was logged in this incident.

## Acceptance scenario

- **Seed:** An owner whose archive reader takes 2 s to answer a search read.
- **Action:** One `POST /sessions/v1/search`.
- **Expected:** `owner_request_completed` for it carries `awaited_ms` of about 2,000, no
  `owner_request_slow` line is written, and the supervisor's next observation does not list
  `owner_slow_reads` for it.
- **Replayable offline:** yes
