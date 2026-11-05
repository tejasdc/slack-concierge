---
failure: Service and agent bookkeeping became open Inbox requests during thread migration.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Bookkeeping became Inbox work

## What was seen

The Inbox router received many area suggestions, then recovery notices for requests created from its own upkeep and answer events. At 11:34 UTC on November 5, the live migration recorded open topics and requests rooted in service-origin area suggestions and thread-upkeep notices. Those requests became eligible for another upkeep turn.

## Cause

The one-time thread migration treated every Inbox transcript root as a human request. A service notice or agent coordination input could be a root without Tejas having requested work there. Upkeep then treated the new request as unfinished human work.

## Fix

Recovery of a request now requires a human-authored root or an explicitly routable agent capture. The owner retires old migration-created bookkeeping requests through retained topic events only when they have one nonhuman root, one request sourced to it, no question and no human reply. It leaves their source and agent receipts intact.

## Acceptance scenario

- **Seed:** One human Inbox message and one service-authored area suggestion, each retained as an Inbox input. Also seed an older recovered topic with one request sourced only to the service suggestion.
- **Action:** Run topic migration, then the owner correction and thread upkeep twice.
- **Expected:** The human message still has its open request. The service suggestion creates no new request. The old synthetic request closes once and does not generate an upkeep input; the original input and topic events remain readable.
- **Replayable offline:** yes (`bot/tests/inbox-bookkeeping-recovery.test.ts` in an isolated state directory; agent-run tests were disabled on the incident host).
