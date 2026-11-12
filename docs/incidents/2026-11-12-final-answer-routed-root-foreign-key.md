---
failure: A final answer routed into a shared Inbox topic failed with a SQLite foreign-key error after its marked partial answer had posted successfully.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Final answers could not be filed into a routed thread from an earlier Inbox

## What was seen

The accepted request `10f43a6e` successfully posted its marked partial answer. Its final answer
then failed while being filed, both when the final supplied text and when it was bodyless and
carried the earlier answer. The owner reported `FOREIGN KEY constraint failed` in the final
reply path.

The relevant route was `topic-change:86c4e86d-cd74-41f5-b404-c6e90301581e`, retained in Inbox
3172. The request and current Inbox were in session 9326. Its shared topic had that historical
routed root as its only root; the source thread had `request:8e4...` and a thread-upkeep root.
The dispatch marked the answer as shared across topics, so only final-answer upkeep attempted
the copy into the other topic. Partial answers did not mirror.

## Cause

The final mirror selected the historical `topic-change:` root and wrote its post in Inbox 9326.
The input column on an owner event is a foreign key to a retained session input. A routed
destination is instead an event address; its real input anchor is the action input retained
with the route event in Inbox 3172.

`topicRouteAnchor` searched only events whose session matched the writer (9326), so it found no
anchor for the route stored in 3172. `recordSessionEvent` then passed the synthetic
`topic-change:` event address into the input foreign key and SQLite refused the insert. A
bodyless final still reaches this final mirror after reusing the earlier partial post, so it
fails at the same anchor boundary.

## Fix

Anchor lookup now uses the established Inbox lineage query. A current Inbox can resolve the
retained route input from an earlier Inbox session; an unrelated non-Inbox session still sees
only its own accepted-handoff lineage. Same-session route lookup remains unchanged.

## Acceptance scenario

- **Seed:** In an empty scratch ledger create Inbox sessions 3172 and 9326, plus ordinary
  session 9999 with no Inbox handoff. Retain input `route-action` in 3172 and record
  `topic-change:86c4e86d-cd74-41f5-b404-c6e90301581e` as a `topic_route` event in 3172 with
  `input_id='route-action'`. This reproduces the route and custody shape from the incident.
- **Action:** Call `postForwardedThreadAnswer` with `inboxSessionId:9326`, that historical root,
  `eventId:'cross-inbox-final'`, `requestId:'request:probe'`, a nonempty final body, and no
  attachments. Then call `recordSessionEvent` with the same root as `inputId` under session
  9999.
- **Expected:** `postForwardedThreadAnswer` records the final with the route's retained input
  anchor and preserves the routed root in the payload. The unrelated write fails its foreign
  key. A route looked up through its own session also resolves to `route-action`.
- **Replayable offline:** yes, the two calls above exercise existing application entry points
  against the normal owner schema in a disposable state directory. The ignored probes under
  `bot/tmp/reviews/` preserve this exact seed and observed output but are not the durable
  acceptance contract. The scenario does not recreate all dispatch and shared-topic selection
  state.
