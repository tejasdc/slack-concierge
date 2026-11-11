---
failure: A completed Inbox notice repair stayed open because a later shared check failed for attachment steering.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# A finished notice repair could not close

## What was seen

The notice repair had an installed answer and a later browser check that passed its
notice placement and Send-button checks. That browser check covered four reports and
failed overall because attachment steering was unverified. The Inbox router's attempt
to close the notice request was refused as unfinished, naming the shared dispatch
`bd7aa504-ec68-4231-ac14-238bc2924f2a`.

## Cause

The closure guard evaluated the latest linked dispatch's aggregate outcome for each
human request. It had no way to accept exact evidence that an earlier answer finished
this request and the shared failed check confirmed this request's portion passed.

## Fix

For a failed dispatch linked to multiple Inbox requests, the guard accepts a
request-specific close only when the router cites both the earlier answered final
and the later failed final. It verifies the unsuperseded event identities and their
linked dispatches. The router still judges the check's words against the individual
request and records the remaining device evidence boundary. The sibling with no
completed answer stays open.

## Acceptance scenario

- **Seed:** Create two Inbox requests. Link one to an earlier answered final; link
  both to a later shared failed final that says the first request passed its check
  while the second is unverified.
- **Action:** Try to close the first request with only its earlier final, try to
  close the second with the shared failed final, then close the first citing both.
- **Expected:** The first two closes are refused. The third closes only the first
  request; the second remains open, and neither historical dispatch is replayed.
- **Replayable offline:** yes (`bot/scripts/legacy-topic-completion-fixture.ts`).
