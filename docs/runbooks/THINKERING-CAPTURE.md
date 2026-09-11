# Thinkering Send to Slack contract

Concierge owns this HTTP contract and Slack delivery. Thinkering calls it from
its authenticated server route; the browser never receives the ingress token
or a Slack credential. The destination is configured by Concierge as Tejas's
DM inbox, `D0BMWUJ3RD5`.

## Request

`POST https://capture.tejas.nyc/thinkering` with no query or trailing slash:

```http
Authorization: Bearer <server-side route credential>
Content-Type: application/json
```

```json
{
  "event_id": "thinkering-<64 lowercase SHA-256 hex characters>",
  "text": "The complete selected thought or thread snapshot"
}
```

These are the only accepted fields. Text must be a nonempty string; its original
whitespace and UTF-8 content are preserved. The complete JSON body, including
escaping and metadata, must fit within 262,144 bytes. Do not truncate or split a
selection to meet the limit: show a useful too-large error instead.

Thinkering computes `event_id` from its versioned snapshot representation,
including ordered object/revision identities and exact text. An unchanged
snapshot reuses that ID across clicks, reloads and retries. An edited snapshot
has a different ID. The caller must never reuse an ID for different text.
Concierge rejects such a conflict with `409` and preserves the first capture.

Concierge's internal ID is SHA-256 over the following UTF-8 strings, each followed
by a NUL byte: `thinkering:v1`, `thinkering`, and the complete caller `event_id`.
The receipt's `event_id` is this internal 64-character hex ID. It is stable
across route configuration changes; the first accepted destination wins.

## Receipt and retry

New durable intake returns `202`; an identical duplicate returns `200`:

```json
{
  "accepted": true,
  "event_id": "<internal 64-character lowercase SHA-256 hex>",
  "duplicate": false,
  "status": "queued",
  "destination_kind": "slack",
  "terminal_receipt": null,
  "trigger": null,
  "webhook_version": null
}
```

| Status | Meaning for the app |
| --- | --- |
| `queued` | Durably accepted for delivery. Show accepted/queued, not delivered. |
| `delivered` | Concierge has confirmed the Slack message. `terminal_receipt` is its timestamp string. |
| `parked` | Accepted, but delivery needs operator inspection. Do not create a new event or claim delivery. |

Repeat the identical request to resolve a lost HTTP response or deliberately
refresh its receipt. A retry never republishes an existing capture, even if
that capture is parked. `202` follows committed SQLite persistence; a transport
failure or `503` can safely retry with the same ID and exact text. There is no
delivery-status polling endpoint or requirement for an app outbox.

Errors have JSON `{ "error": "<reason>" }`: `400` malformed JSON, `401` missing
or wrong bearer, `404` unknown path/query, `405` wrong method, `409` ID/content
conflict, `413` body too large, `415` wrong content type, `422` invalid fields,
and `503` unavailable persistence. Invalid requests are not accepted. Do not
automatically replace IDs on errors; fix invalid input or configuration first.

## Slack result

The capture uses Concierge's existing Slack user token and ordinary DM intake,
so the router can act on it. Short selections appear inline followed by
`— via thinkering`. Long selections produce one user-authored Slack file share
with a short source-marked comment and the full persisted text in
`thinkering-capture.txt`; they do not become several independent router inputs.
Concierge persists and submits the original text without Markdown conversion.
Slack's own [retrieval representation](https://docs.slack.dev/messaging/formatting-message-text/#emoji)
turns inline Unicode emoji into colon names (for example, `😀` becomes
`:grinning:` in API events); attachment bytes remain exact UTF-8.

The existing durable capture row and exact worker claim own publication. An
ambiguous Slack write, unproven file-share receipt, or dead Thinkering sending
owner parks the event rather than risking a second router action. Confirmed
delivery remains terminal. Operator inspection uses the existing capture ledger,
not an app-side Slack API or a new send ID.

Slack's native contracts: [text length and snippets](https://docs.slack.dev/reference/methods/chat.postMessage/#truncating-content)
and [single upload completion](https://docs.slack.dev/reference/methods/files.completeUploadExternal/).

## Credentials and host boundary

Concierge's tracked `bot/scripts/install-capture-ingress.ts` provisions
`/etc/concierge/thinkering.token` without replacing an existing secret.
`agent-inbox.service` receives it as systemd credential `thinkering`.
Only the trusted Concierge service has the Slack user token; public capture
ingress has only route/queue credentials.

Remote-box owns the Thinkering host service and wires this same route credential
into its server-side process through the existing native service configuration.
Never copy values into Git, Slack, a browser bundle, command arguments or logs.
Thinkering uses `THINKERING_SLACK_CAPTURE_URL` and
`THINKERING_SLACK_CAPTURE_TOKEN_FILE`. Remote-box supplies systemd credential
`thinkering-capture-token`, referenced through `%d/thinkering-capture-token`, and
activates both environment settings together after the source token exists.
Host deployment uses remote-box's existing
Git/deploy channel; Concierge follows its separate push-driven release owner.

## Safe synthetic integration

Claim a lane from the Concierge implementation worktree using
`bot/scripts/sandbox-lane-control.sh claim`. The resulting run record supplies
`reserved_capture.ingress_url`; append `/thinkering`. Use that run's
`state/capture-credentials/thinkering` file server-side. The controller maps the
route only to the claimed lane's app DM and uses separate state and secrets.
Keep the exact lane/run ownership until all participating probes have settled.

Run `bun run tests/sandbox/runner.ts execute thinkering-slack --lane lane-N
--run-id <exact-run-id> --apply` from `bot/`. The case verifies short and long
captures, duplicate and conflict responses, one user-authored DM root per
capture, full attachment bytes, exact provider/input ownership, terminal replies
and zero unsettled work. A Thinkering server integration probe must use this
same claimed run and synthetic markers, with the owner coordinating it before
release. Ordinary feature work never sends synthetic traffic to production.

The public edge, production credential loading and Thinkering's host service
require their own release evidence. Sandbox evidence is not production rollout
proof. Follow [live acceptance](LIVE-ACCEPTANCE.md) for later user-initiated proof.

## Initial activation blocker

The 2026-09-11 independent implementation review confirmed that the current
immutable deployment controller installs capture routes and runs the credential
installer from its previous control artifact. Its post-promotion refresh updates
units and router helpers, but does not reload the promoted capture configuration.
A normal push alone therefore does not establish `/thinkering` readiness.
Updating only a candidate deploy script cannot fix that first execution.

The route credential was provisioned with the tracked installer, and remote-box
deployed Thinkering's credential/environment wiring without restarting services.
Those actions do not prove the public capture route is active.

The complete capture change must be integrated before an authorized operator
can invoke the existing source rollout from outside the Concierge service
cgroup, with no immutable control-root override:

```bash
cd /root/workspace/slack-concierge
bot/scripts/deploy.sh
```

This is the established [operator-only path](DEPLOYMENT.md), not an ordinary
feature-agent deployment. Calling it from inside Concierge hands off to the
old immutable controller and does not resolve this first-activation blocker.
The 2026-09-11 coordinating request explicitly authorized this operator-owned
activation after the branch's complete acceptance. The operator must preserve
admission/drain and exact runtime
health gates. The edge owner also publishes the tested exact `/thinkering`
allowlist through its existing Wrangler command. Verify the loaded route and
credential at activation; defer production capture traffic to the later
user-initiated live acceptance. The independent review identified this activation
blocker; the authorized source-rollout handoff resolves ownership, while the
detached runner still owes actual activation and health proof. Sandbox evidence
must never be relabeled as production readiness.
