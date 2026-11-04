---
failure: Pressing "Make it its own request" on a routed Inbox message always failed because Concierge required a boolean present field that unthread does not send.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# "Make it its own request" was refused on every press

## What was seen

In an Inbox thread on thnkr.ing, a capture placed into the thread shows "Make it its own request" (`unthread`). Pressing it always failed ("That was not confirmed; it stays in this thread."), and the self-service split control had zero recorded uses across the ledger.

## Cause

thnkr.ing validates `POST /sessions/:id/message-actions` strictly and defines the `unthread` action variant as `{kind: "unthread", messageId}` with no `present` field. Concierge's `SessionOwner.messageAction` validated `typeof action.present !== 'boolean'` unconditionally across all four action kinds (`reaction`, `save`, `follow`, `unthread`), rejecting every `unthread` body from thnkr.ing with HTTP 400 (`Exact message action required.`) while thnkr.ing rejected any body that included `present`.

## Fix

`SessionOwner.messageAction` requires `action.present` to be omitted (`undefined`) when `action.kind === 'unthread'`, while continuing to require a boolean `present` for `reaction`, `save`, and `follow`. Repeats under the same `clientActionId` continue to return the original completed operation receipt through `saveControl`.

## Acceptance scenario

- **Seed:** An Inbox session holds a thread root message and a second capture routed into that thread via `thread_link` (`attached: true`).
- **Action:** Call `POST /sessions/v1/sessions/:id/message-actions` with `{clientActionId, action: {kind: "unthread", messageId}}` (no `present`), then repeat the identical request with the same `clientActionId`, then send a second `unthread` with a new `clientActionId`, and send `save`/`reaction`/`follow` without `present`.
- **Expected:** The first `unthread` succeeds (200) and detaches the capture (`attached: false`); the repeat with the same `clientActionId` returns 200 with the original completed operation receipt; a new `clientActionId` against the already-detached capture returns 409 (`That message was not routed into a thread.`); `save`, `reaction`, and `follow` without boolean `present` (and `unthread` with `present`) still return 400 (`Exact message action required.`).
- **Replayable offline:** yes
