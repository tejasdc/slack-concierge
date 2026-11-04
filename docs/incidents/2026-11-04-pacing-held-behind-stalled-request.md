---
failure: Eighteen nightly findings waited 11.5 hours undelivered behind one request whose recipient stopped without replying, because pacing waited for a settlement that never comes.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Nightly findings held all night behind a stalled request

## What was seen

The 2026-11-03 nightly review (concierge:7519) sent 61 findings two lanes at a time with
`--after-settled`. Request 03baac37 to concierge:7269 was acknowledged at 18:26:58 UTC; that run
ended without a final reply, was asked once to report back, and ended again without one
(18:43:44 UTC). Concierge marked it stalled, which leaves a request open. The 18 findings behind it
in its lane (every even one from 26 to 60) were still undelivered at 06:05 UTC on 2026-11-04.

## Cause

`--after-settled` (2026-11-02) waited for the earlier request to have an outcome. A stalled request
gets `stalled_at_ms` and no outcome, by design, so a late answer can still settle it; nothing
settles it otherwise. Pacing therefore depended on a peer finishing, the same class of fault as
the 2026-11-01 lane break.

## Fix

A paced request now waits only while the earlier request is neither settled nor stalled. The
stalled request itself is unchanged and still open. The overdue inspection uses the same rule, so
a request released past a stalled one gets its reminder clock as soon as it is delivered.

## Acceptance scenario

- **Seed:** request A to a session; request B with `--after-settled A`.
- **Action:** A's recipient ends its run twice without a final reply, so A is marked stalled.
- **Expected:** B is delivered at the next dispatch sweep after the stall mark; A stays open and
  can still be answered.
- **Replayable offline:** no (needs the dispatcher and a recipient run that ends without replying).
