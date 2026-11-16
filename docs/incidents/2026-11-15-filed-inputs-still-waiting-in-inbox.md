---
failure: Inputs already placed in threads still appeared as waiting to be sorted after an Inbox router change.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# Filed inputs still waiting in the Inbox

## What was seen

Tejas reported the sorting pile again after the November 11 former-router recovery fix.
The first five checked inputs in an eight-row prepared sorting list already resolved to
placed threads through canonical message reads. This is a disagreement between retained
filing and the prepared list, not evidence that those inputs should be filed again.

## Cause

Canonical thread placement selects the latest placement event for the exact input across
Inbox routers. The prepared resolver and human-message display restricted placement to
the session that originally accepted the message. A successor's successful placement
therefore left the predecessor's prepared row at its old, apparently unfiled root. The
prepared resolver also restricted recursive reply-target lookup to the exact session,
while canonical reads follow the retained Inbox lineage.

These source defects are confirmed by the disposable worker regression. The exact
event/session pairing behind every reported live row was not inspected by that fixture.

## Fix

Prepared roots follow Inbox lineage and the globally latest input placement, including
detach and relink. The displayed reply target, routing attribution and compact receipts
follow that same placement through one shared read-only helper. Existing receipts refresh
through the worker's bounded revision rebuild. A versioned upgrade reprojects existing messages in 100-row pages and drains
affected summaries in bounded batches. It removes empty false waiting roots while keeping
genuinely unfiled work. The ledger stays read-only; no accepted operation is replayed.

The existing overdue-work upkeep also reminds the current Inbox after thirty minutes,
including while it is busy or already has queued work. The reminder uses the current
router, milestone and exact overdue-root set for durable deduplication. It adds no timer and does not restart the active turn.
The earlier idle wake and repair notice retain their separate purposes.

## Acceptance scenario

- **Seed:** One router accepted human messages; a successor placed them in a filed root.
  Preserve 105 old prepared rows at their former unfiled roots, plus one genuinely
  unfiled message and a successor-authored reply to a predecessor message.
- **Action:** Start the real presentation worker without adding a source change; then
  detach a predecessor input, relink it from the successor, and add a new reply.
- **Expected:** The versioned upgrade removes all 105 phantom waiting roots without
  changing canonical events or the active generation. The genuine unfiled root remains;
  initial and incremental replies follow the canonical thread; latest detach and relink
  update placement and displayed routing. An independently seeded thirty-minute-old
  unfiled input produces one reminder to a busy current router, with repeated upkeep
  deduplicating for that router, while a successor receives its own reminder; already-filed
  roots produce none.
- **Replayable offline:** yes; run `bun run scripts/inbox-prepared-lineage-fixture.ts`
  and `bun run scripts/inbox-unfiled-across-routers-fixture.ts` from `bot/`. Both own
  disposable state. Production installation and a live sorting-list read remain separate
  delivery checks.
