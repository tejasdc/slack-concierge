---
failure: Seven nightly findings waited 6.5 hours undelivered behind a request whose recipient's run had ended with progress replies and no final, because that request was never marked stalled.
date: 2026-11-05
fix_commits: []
cause_status: best-explanation
---

# Nightly findings held behind a run that ended without being marked stalled

## What was seen

The 2026-11-04 nightly review (concierge:7519) paced its findings two lanes at a time with
`--after-settled`. Request 9cb21d8f to concierge:7845 ran from 00:54:22 to 00:55:57 UTC on
2026-11-05, sent six progress replies and no final. Concierge's log has no report-back and no stall
line for it (other requests that night have both), so it stayed open and unmarked, and the 7 findings
behind it were undelivered until the review canceled it at 07:33 UTC.

## Cause

Pacing (2026-11-04, PR #390) passed a request only once it had settled or been marked stalled. The
stall mark comes from the stranded-request chase, which takes no step while it judges the worker
still able to wake (busy, or waiting on its own requests or a named watch); this request never got
one. Why the chase stayed silent for 9cb21d8f is not established: the request ledger is not readable
from the fixing session, and the log shows only the absence. The deeper fault is that pacing
depended on the chase at all.

## Fix

A paced request now waits only while the earlier request is being worked on: it goes out when the
earlier one has settled, is marked stalled, or the run that held it has ended (done, failed or
canceled, following a provider continuation), with or without a final reply. The earlier request is
unchanged and still open, so a late answer still settles it.

## Acceptance scenario

- **Seed:** request A to a session; request B with `--after-settled A`.
- **Action:** A's recipient run ends with a progress reply and no final, and no stall is marked.
- **Expected:** B is delivered at the next dispatch sweep after A's run ends; A stays open.
- **Replayable offline:** no (needs the dispatcher and a recipient run).
