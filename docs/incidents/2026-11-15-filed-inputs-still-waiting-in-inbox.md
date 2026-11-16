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

The subsequent source review also demonstrated an interruption window: incremental
reassignment committed message pages before refreshing the old root summary. A worker
loss could leave that summary with zero members, or leave descendants under an old root
that a retry could no longer find after the linked input moved. The first versioned
repair could not discover zero-member summaries and did not correct a stale cached topic
when its root stayed the same. These defects are reproduced offline; they do not prove
which unclassified live rows experienced interruption. An indexing response is still a
coverage boundary, not evidence that semantic repair has finished.

Live acceptance on November 16 UTC (November 15 locally) observed the semantic upgrade
running from 03:41 UTC through 03:58 without a completion record. An ordinary release restart at 04:01 interrupted it. Its
message and root-sweep positions were local variables, so another worker had to repeat
the scan. Incremental reassignment already retained its own continuation; the one-time
semantic upgrade still needed the same durable progress boundary.

## Fix

Prepared roots follow Inbox lineage and the globally latest input placement, including
detach and relink. The displayed reply target, routing attribution and compact receipts
follow that same placement through one shared read-only helper. Existing receipts refresh
through the worker's bounded revision rebuild. A versioned upgrade reprojects existing messages in 100-row pages and drains
affected summaries in bounded batches. It removes empty false waiting roots while keeping
genuinely unfiled work. The ledger stays read-only; no accepted operation is replayed.

Semantic version 2 reruns on stores that already completed version 1, corrects cached
topic membership independently of root changes, and also sweeps existing summaries to
remove zero-member orphans. Each future incremental page commits its old/new summary
maintenance and durable original-root continuation with its message changes. A restarted
worker resumes remaining descendants and drains persistent topic work even without a new
source change. Completion diagnostics count orphan removals; a separate content-free
record attempts to name each removed empty human root and its current canonical target.
That per-root log is best-effort after commit; it can be absent on interruption even
though the durable orphan count and cursor include the removal.

The semantic upgrade now commits its phase, message/root keysets, cumulative counts and
original start time with each page. A release restart continues from committed progress
and drains persistent dependencies before completing. No timeout is lengthened and no
semantic version bump is needed. Content-free phase/cursor/resume logs let acceptance
observe continuation before the entire upgrade finishes. Post-commit logs may be lost on
interruption; stored progress and subsequent source-head advancement remain evidence.

The existing overdue-work upkeep also reminds the current Inbox after thirty minutes,
including while it is busy or already has queued work. The reminder uses the current
router, milestone and exact overdue-root set for durable deduplication. It adds no timer and does not restart the active turn.
The earlier idle wake and repair notice retain their separate purposes.

## Acceptance scenario

- **Seed:** One router accepted human messages; a successor placed them in a filed root.
  Preserve 105 old prepared rows at their former unfiled roots, plus one genuinely
  unfiled message and a successor-authored reply to a predecessor message.
  Include an already-version-1 store with an empty obsolete sorting root and a message
  whose correct root still carries an obsolete cached topic. A separate parent message
  has 125 retained replies under its root.
- **Action:** Start the real presentation worker without adding a source change; then
  detach a predecessor input, relink it from the successor, and add a new reply.
  Link the 125-reply parent to a placed root, pause the real worker immediately after its
  first remap transaction commits, kill it, then start a fresh worker twice.
  Separately interrupt the semantic message scan after its first committed 100 rows,
  its root sweep after its first committed page, and its persistent dependency-drain
  phase; use a fixture-owned synchronous post-commit barrier for each restart.
- **Expected:** The versioned upgrade removes all 105 phantom waiting roots without
  changing canonical events or the active generation. The genuine unfiled root remains;
  initial and incremental replies follow the canonical thread; latest detach and relink
  update placement and displayed routing. The independently seeded root with no members
  is removed; unchanged-root cached topics are corrected. At the
  interruption boundary the parent has moved while 26 descendants remain. Restarting
  finishes those descendants, removes the empty old summary, preserves the generation
  and canonical events, and a second restart preserves that result. An independently seeded
  thirty-minute-old unfiled input produces one reminder to a busy current router, with repeated upkeep
  deduplicating for that router, while a successor receives its own reminder; already-filed
  roots produce none.
  Semantic restarts visit each prepared message once, continue beyond the committed root
  keyset, retain cumulative orphan counts and drain pending dependencies before marking
  completion. The active generation and canonical event count remain unchanged.
- **Replayable offline:** yes; run `bun run scripts/inbox-prepared-lineage-fixture.ts`
  and `bun run scripts/inbox-unfiled-across-routers-fixture.ts` from `bot/`. Both own
  disposable state. Production installation and a live sorting-list read remain separate
  delivery checks.
