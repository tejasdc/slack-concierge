# Thinkering → Concierge DM capture

This is one delivery for Tejas's personal, authenticated Thinkering app. Concierge
owns intake and Slack publication; Thinkering owns selecting and rendering a
thought/thread snapshot and its authenticated same-origin Send to Slack action.

## Contract and ownership

- `POST https://capture.tejas.nyc/thinkering`, JSON `{ "event_id":
  "thinkering-<64 lowercase SHA-256 hex characters>", "text": "selected snapshot" }`.
- The app computes the ID from its versioned ordered object/revision/text
  snapshot. Identical snapshots reuse it across retries/reloads. Changed
  snapshots get another ID. The app keeps the bearer credential server-side.
- A dedicated `thinkering` capture credential lives at
  `/etc/concierge/thinkering.token`; Concierge's tracked installer provisions it
  without replacing an existing value and its ingress unit receives it through
  `LoadCredential`. Remote-box owns Thinkering's host credential wiring.
- The request has a 256 KiB body ceiling. Nonempty text is preserved exactly;
  no client-supplied channel, trigger, sink, or source label is accepted.
- The configured destination is `D0BMWUJ3RD5`. The durable effect is the text
  followed by `\n\n— via thinkering`. Internal event identity is SHA-256 of
  NUL-terminated `thinkering:v1`, route ID `thinkering`, and caller event ID.
  Reusing an ID with different text returns 409. No accepted row is overwritten.
- New durable acceptance returns 202; exact duplicate returns 200. Both use
  the existing `accepted`, `event_id`, `duplicate`, `status`, `destination_kind`,
  and `terminal_receipt` receipt. Intake success is queued, not proof of Slack
  delivery. Retrying the identical request reads the existing delivery status;
  no new polling endpoint or client outbox is introduced.
- The trusted capture worker keeps the existing plain-text Slack capture path
  for short text, bypassing Markdown conversion with `mrkdwn:false`. It reuses
  only the existing service-owned router file transport for longer content,
  passed as exact UTF-8 bytes in one `thinkering-capture.txt`
  attachment with a short `— via thinkering` comment, preventing split inputs.
  The existing capture row is immutable publication intent, and the existing
  sending claim owns the attempt. An ambiguous publication or dead sending owner
  for this route parks; it is never blindly replayed. No new queue/schema/service,
  recurring work, provider credential, or Slack scope is required.
- The edge adds only exact POST `/thinkering`. Existing `/pebble`, `/audio`,
  journal handoff, queue authentication, and provider lifecycle stay compatible.

## Acceptance and rollout

Focused tests cover strict JSON/auth/body validation, stable IDs, conflicts,
durable-before-202 acceptance, duplicate canonical receipts, user-token inline
and full-file delivery, and dead-owner/ambiguous-write parking. Existing capture,
queue, edge and deployment fixtures establish the affected regressions.

A claimed four-lane sandbox provides the actual ingress with a run-only
Thinkering credential and destination bound to its own app DM. Send short and
long synthetic snapshots, repeat them, reject changed-content ID reuse, and join
each capture row to one user-authored Slack root, one durable input/provider
turn, complete attachment content and terminal response. Release after drain.
Thinkering can use the same owned lane contract for a contained server-to-ingress
probe; no production validation capture is permitted in this turn.

One fresh-context implementation review inspects the whole diff and available
evidence. Apply justified corrections, verify, run the repository gate, commit
and push main. Concierge's detached deploy owner handles rollout; no feature
agent waits for deployment. Edge publication follows its existing repository
channel. Remote-box receives the concrete host wiring request and contract.

Plan review found one concrete blocker: routing text through the Markdown
converter changes snapshot content. The lossless inline/file distinction above
is the smallest correction; no additional review cycle is required.

Implementation review found no further auth, secret-exposure, or publication
blocker, but confirmed the existing controller cannot activate this new route
on its first ordinary deployment. The explicit operator activation requirement
is recorded in the contract runbook. The coordinating request subsequently
authorized operator-owned activation through that source path; publish the
complete change and hand it off without waiting inside the provider turn.
Local correction also grants the existing four-candidate cancellation
fixture 20 seconds: it reproduced a 6.02-second setup against Bun's five-second
default while preserving every cancellation assertion.
