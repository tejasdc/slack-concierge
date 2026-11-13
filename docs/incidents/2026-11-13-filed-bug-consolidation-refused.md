---
failure: The agent owner refused consolidation of two independently filed reports of the same notification issue and a scoped secondary route from an independently filed Spotify report.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Bug intake protection also blocked later organization

## What was seen

The Inbox had two notification-navigation topics with separate retained reports and requests,
both assigned to the same investigation. Tejas identified them as one issue. The supported
agent merge returned `BUG_REPORT_OWN_THREAD`, with no accepted effect. The same refusal
blocked routing the notification concern from an independently filed Spotify reconnection
report. That reconnection report must remain in its own primary topic.

## Cause

The Nov 5 intake guard protected the right boundary: a new bug-button submission enters
Inbox independently, rather than becoming a reply to a worker
[decision: inbox-button-always-new-request]. Applying that guard to every later merge and
route also prevented consolidation of the same concern
[decision: related-captures-share-one-thread]. The initial implementation fixture tested
the human merge entrance and invented a side message; neither exercised the refused agent
contract, so that evidence was rejected before release.

## Fix

The existing agent merge now records the exact source topic, survivor, reason and retained
human correction. When the source holds a bug report, both topics must already hold bug
reports; the correction is a human
non-bug message in the survivor. Existing agent routing accepts a scoped secondary reference
to an already-filed bug root, without moving or rewriting the source. The scope is attributed
to the acting agent in both page and detail readers. Existing action custody and idempotency
remain the enforcement boundary; there is no new store or bypass.

Independent review caught an in-scope regression before release: the first candidate also
refused an ordinary source topic merging into a bug-report destination, which the prior
contract allowed. The correction confines the additional checks to bug-report sources and
exercises the ordinary-to-bug direction as a successful, idempotent operation. It retains
the bug-source-to-nonbug refusal and explicitly sourced bug-report consolidation.

## Acceptance scenario

- **Seed:** two independently filed notification bug topics, an ordinary human correction in
  the survivor, three requests and one shared notification dispatch; an independent Spotify bug root.
- **Action:** agent merge with the retained correction, and scoped secondary route of the exact
  Spotify capture; repeat each action with its original identity and try invalid initial placements.
- **Expected:** one notification topic retains all reports, requests and the original dispatch;
  Spotify remains primary; original bytes and attribution survive; retries return their first
  receipt and changed payloads conflict; direct initial intake remains refused.
- **Replayable offline:** yes.

Replay in an isolated state directory with
`bun run bot/scripts/notification-topic-correction-acceptance.ts`. It exercises actual agent
operations, invalid correction refusals, original payload/attachment retention, independent
Spotify placement, three retained requests, one shared dispatch, action replay/conflicts,
initial intake refusals, and prepared-page/detail agreement. It also checks ordinary routing
and merge. This proves owner semantics in disposable state; installed behavior and visible
consolidation require the parent repair session's separate marked live action and browser
readback. Current behavior is documented in the [native Inbox contract](../contracts/native-inbox.md).
