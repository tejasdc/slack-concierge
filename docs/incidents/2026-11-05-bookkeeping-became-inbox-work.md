---
failure: Service and agent bookkeeping became open Inbox requests during thread migration.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Bookkeeping became Inbox work

## What was seen

The Inbox router received many area suggestions, then recovery notices for requests created from its own upkeep and answer events. At 11:34 UTC on November 5, the live migration recorded open topics and requests rooted in service-origin area suggestions and thread-upkeep notices. Those requests became eligible for another upkeep turn. A later read-only ledger check found 62 open recovered requests rooted in returned results and 295 rooted in upkeep notices. Of the 62 return-rooted topics, 18 had additional upkeep roots and no recorded question. These are separate from their original communication requests or human work.

## Cause

The one-time thread migration treated every Inbox transcript root as a human request. A service notice or agent coordination input could be a root without Tejas having requested work there. Upkeep then treated the new request as unfinished human work.

## Fix

Recovery of a request now requires a human-authored root or an explicitly routable agent capture. The owner retires old migration-created bookkeeping requests through retained topic events only when every root is nonhuman and not routable, one request is sourced to one of those roots, and there is no question or human reply. This includes a returned result grouped with its subsequent upkeep notices. The correction compares the request's current linked dispatches with those in its original migration event. A later assignment keeps the request open for the normal checked-outcome path; this matters because the Inbox router has since sent real repair work from some of the synthetic threads. A returned result's closure cites the matching communication event and original request when its retained receipt matches; a project setup return cites its order when matched. An upkeep notice cites the original Inbox request and source input when that relation can be proven. The synthetic roots themselves prove their extra recovered request was not a human obligation, even if an older receipt lacks the optional link. Original requests, outcome receipts, inputs and topic history stay intact. The original work's completion is still decided by its own exact request and answer.

## Acceptance scenario

- **Seed:** One human Inbox message and one service-authored area suggestion, each retained as an Inbox input. Also seed older recovered topics with requests sourced only to a return, an upkeep notice and the service suggestion.
- **Action:** Run topic migration, then the owner correction and thread upkeep twice.
- **Expected:** The human message still has its open request. The service suggestion and returned result create no new requests. The old synthetic requests close once and do not generate upkeep inputs; the original requests, result receipts, inputs and topic events remain readable.
- **Replayable offline:** yes (`bot/tests/inbox-bookkeeping-recovery.test.ts` in an isolated state directory; agent-run tests were disabled on the incident host).
