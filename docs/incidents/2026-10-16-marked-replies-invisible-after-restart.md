---
failure: Accepted agent-marked replies stayed missing from their Inbox topic after a restart because a full history rebuild could not finish.
date: 2026-10-16
fix_commits: [a3b30fdc, 8fcf2e4f, 8f65972f, e2ea4699]
cause_status: best-explanation
---

# Accepted marked Inbox replies stayed invisible after a restart

## What was seen

Marked agent replies (trusted agent checks sent as a reply to one of Tejas's messages) had been accepted
but did not show in their topic or nested message conversation, and kept not showing after Concierge
restarted. Releases kept landing, so the repair never completed.

## Cause

a3b30fdc changed the reply-lineage rule so marked replies follow the same lineage as Tejas's message. That
bumped `marked_reply_roots_version`, and `catchUp()` in `bot/src/presentation-message-worker.ts` answered
a version below 1 with a full `rebuild()` of the prepared message generation across all retained history.
Each release restart interrupted that rebuild, so the corrected placement was never committed and old rows
stayed in place. Best explanation: the stall is inferred from the commit message ("unrelated releases prevent
a full shadow generation from finishing") and the shape of the code; the rebuild's actual duration and
interruptions were not observed here. 8fcf2e4f also notes that the rebuild showed an empty "indexing" state
to Inbox reads while it ran.

## Fix

- a3b30fdc: marked replies follow the shared reply lineage (`inbox-reply-lineage.ts`).
- 8fcf2e4f: keep serving the complete active generation until the rebuild activates, so Inbox reads stay up.
- 8f65972f: replace the full rebuild with `upgradeMarkedReplyRoots`, which selects only trusted marked
  replies (agent origin, surface scope, source input and run match, `replyToMessage` present) in batches of
  50, reprojects them with their descendants and affected topics, and commits the version last, so it is
  idempotent and a restart simply repeats it.
- e2ea4699: the upgrade snapshots every affected root and does the moves and the version write in one
  prepared-store transaction, so a restart leaves all-old or all-corrected placement, never stranded
  descendants.

## Acceptance scenario

- **Seed:** A ledger with a few thousand retained inputs and several marked replies stored in the old
  placement; prepared store with `marked_reply_roots_version=0`.
- **Action:** Start the presentation worker, then kill and restart it midway, twice.
- **Expected:** Within one bounded pass after any restart the marked replies and their descendants appear
  under the right topic and nested conversation; topic reads stay available throughout; the version is
  written only after all moves; no full rebuild runs.
- **Replayable offline:** yes (synthetic ledger and prepared store; the worker is local code)
