---
failure: Requests still waiting their turn behind earlier requests sent their asker "no confirmed answer, inspect the recipient" reminders before any agent had them.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Queued requests reported as late before they were delivered

## What was seen

thnkr.ing's nightly review (concierge:7519) hands its findings out two at a time, each later
finding waiting behind an earlier request. On 2026-11-02 it received about ten 15-minute
"No confirmed answer … inspect the recipient" reminders for requests that were only queued: no
agent had started them, so there was nothing to inspect.

## Cause

A request's reminder clock (`due_at_ms`) starts when it is asked. A request held by
`--after-request` or `--after-settled` is not handed to its agent until those settle, but the
overdue inspection did not look at that and reported it like a delivered request.

## Fix

The overdue inspection pushes the clock forward while any request it waits behind is unsettled,
and dispatch restarts the clock at the moment a waiting request is handed over, so the agent gets
the same 15 minutes as any other request.

## Acceptance scenario

- **Seed:** request A to a busy session; request B with `--after-settled A`, A open for over 15 minutes.
- **Action:** the 15-minute inspection runs.
- **Expected:** no overdue reminder for B while A is open; after A settles and B is delivered, B's
  first reminder comes no sooner than 15 minutes after delivery.
- **Replayable offline:** no (needs the request dispatcher and live sessions).
