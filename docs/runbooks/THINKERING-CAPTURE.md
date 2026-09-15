# Thinkering capture contract

Concierge owns this HTTP contract and Slack delivery. Thinkering calls it from
its authenticated server route; the browser never receives the ingress token
or a Slack credential. The destination is configured by Concierge as Tejas's
DM inbox, `D0BMWUJ3RD5`.

## Request

`POST https://capture.tejas.nyc/thinkering` with no query or trailing slash:

```http
Authorization: Bearer <server-side route credential>
Content-Type: application/json
X-Thinkering-Request-Id: <optional UUID for this HTTP attempt>
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

The optional request header is diagnostic correlation only. Thinkering generates
one UUID before each browser HTTP attempt and forwards that value unchanged from
its server to Concierge. A later attempt gets a fresh request UUID while retaining
the exact capture event ID and text. Concierge accepts the 36-character
`8-4-4-4-12` hexadecimal UUID form, case-insensitively, preserving the supplied
case. Missing, malformed or combined values are ignored without rejecting the
capture; raw invalid values are never logged. It grants no authentication,
idempotency or ownership authority.

Concierge independently generates a UUID for every request reaching its capture
handler and returns it in `X-Request-Id`, including rejected requests. Thinkering
records that downstream ID separately from its own app-server request ID. Neither
request ID is added to the JSON body or receipt. The generic event/field contract
and its evidence limits are in [capture request diagnostics](../architecture/CAPTURE-INGRESS.md#request-diagnostics).

Concierge's internal ID is SHA-256 over the following UTF-8 strings, each followed
by a NUL byte: `thinkering:v1`, `thinkering`, and the complete caller `event_id`.
The receipt's `event_id` is this internal 64-character hex ID. It is stable
across route configuration changes; the first accepted destination wins.

## Bug reports with existing diagnostics

The existing text contract also carries a complete structured bug report. No
ingress extension, new credential, destination, source adapter or delivery path
is needed. Thinkering owns the global report UI and freezes the description,
report timestamp, diagnostics capture timestamp and existing diagnostics JSON
as one immutable report. Begin its text with `Thinkering bug report` so the DM
router can distinguish the report from an ordinary note. Include the complete
diagnostics JSON verbatim within that report, with a clearly marked boundary;
do not summarize, truncate or recollect it when refreshing a receipt or retrying.

Compute the existing `thinkering-<sha256>` caller event ID from a versioned frozen
report representation. A new report has its own frozen timestamp and identity;
all attempts for that report preserve its event ID and exact text. Per-attempt
request UUIDs remain separate. Apply the same queued, delivered, parked and
uncertain-outcome behavior as other captures. The complete encoded HTTP body
must still fit within 262,144 bytes. If it does not fit, show the size failure
and preserve the report locally; do not silently drop diagnostics or split one
report into several captures.

This contract delivers **one combined report**, not a separate
`thinkering-diagnostics.json` attachment. Short reports appear inline; reports
above the existing inline boundary become one `thinkering-capture.txt` file
containing the full report followed by the `via thinkering` source marker.
The embedded JSON bytes remain exact in the long file. Its fixed filename and
source marker do not change for bug reports. Additional request properties such
as `attachments`, `filename`, `kind` or session targets are rejected. The app
must describe the actual combined-report delivery rather than promise a
standalone JSON attachment.

Uploading a report transfers its description and the frozen diagnostic snapshot
to Slack. Thinkering owns the export's field/privacy contract and explains the
retained window to the user. The reporter consumes the existing bounded history;
this transport agreement does not expand retention or promise that evicted
events, raw console output or historical UI state can be recovered.

### Session identity is evidence, not a capture target

There are currently **no session-discovery or session-target fields accepted by
capture ingress**. Diagnostics `sessionId` identifies a browser page lifetime;
it must never be relabeled as an agent session. Available authoritative native
provider/account/session identities, Thinkering object/run IDs, or exact Slack
`channel_id` and visible `root_ts` may be retained as explicitly named evidence
inside report text. Preserve each identity's actual source and namespace; leave
unavailable fields absent instead of constructing or inferring them.

The separate session-discovery work remains a design consultation, not a live
capture-target API. The existing inbox router validates its destination through
[router search and context](ROUTER-ACTIONS.md#historical-thread-discovery), using
the capture's actual Slack input timestamp as its search cutoff. The report's
timestamps and identity hints cannot override that routing evidence or turn a
browser session into an agent binding.

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

An app may refresh the receipt automatically during the original send interaction.
Keep the exact immutable event ID and text across every request, including when
the user edits the selection meanwhile. Bound the foreground wait: `delivered`
confirms completion, `parked` stops refresh for inspection, and an expired wait
reports unconfirmed delivery, which may still complete later. HTTP `200` alone
does not mean delivered. Do not mint another ID to recover an uncertain send.

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

For the global bug reporter, the app integration probe uses the same claimed
run and real ingress. Submit a synthetic description with frozen timestamps and
diagnostics JSON through the actual app action. Compare the complete expected
report with the delivered file bytes, including the embedded JSON; repeat the
same frozen report to prove the canonical event and terminal Slack receipt stay
unchanged. Join that event to exactly one user input claim and one provider turn.
Keep the app's queued, parked and lost-response checks in its existing isolated
HTTP/browser fixtures; never inject those failures or synthetic reports into
production. Close owned app/browser processes and settle the run before its
owner releases the exact lane/run ID.

## Acceptance evidence — 2026-09-11

The first real Thinkering text capture is **live-verified**, including its
idempotent receipt refresh. Inspection was read-only; this acceptance record
created no production capture.

- Concierge source/runtime: `6ccea66455e384d5abb8fd411b7fdc60713563bf`.
  Deployment run `a7381ac6-adb8-44d2-866d-a4a266fba70f` succeeded at
  `2026-09-11 20:47:07 UTC`, with functional capture/service health and released
  admission gates; service invocation `2f4852454ca44bd788c4dcc086444f31`.
- Thinkering release for this first capture: `2bcbf21dc0dfbf4c98d0195add54778b07c8c749`.
  The app owner reported its sealed 19-check/604-browser-execution gate and
  successful activation; the current release pointer was also checked.
- Exact [production DM root](https://tejazz.slack.com/archives/D0BMWUJ3RD5/p1789170298191869?thread_ts=1789170298.191869&cid=D0BMWUJ3RD5):
  `D0BMWUJ3RD5` / `1789170298.191869`, marked `via thinkering`.
- Canonical event: `480e483b231e14e2b633ed343d64d4b2857b56b4f0aa20ff18f3c233edf14373`.
  One capture row, one delivery attempt, one delivered Slack receipt, and one
  user input claim. Concierge turn `877`, session `1142`, finished with response
  delivery confirmed.
- Ingress journal: `2026-09-11T23:44:57.925Z` accepted the event with
  `duplicate=false`, `status=queued`. At `23:45:02.608Z`, the second request
  returned `duplicate=true`, `status=delivered`, and the same terminal receipt
  `1789170298.191869`. It did not send another message.

Keep the remaining evidence scoped to the environment actually exercised:

| Behavior | Existing proof |
| --- | --- |
| Selected thread and latest nested edits; unrelated content excluded | Actual built Thinkering row menu through the claimed real Slack sandbox, marker `THINKERING-MENU-839-20260911`, receipt `1789155108.395539`; native selection and browser menu/palette cases. |
| Markdown characters, Unicode, multiline text, and long selections | App sandbox selection included Markdown and Japanese text. Concierge's committed-source sandbox compared complete long-file bytes and provider START/END markers; short/long receipts `1789156096.215139` and `1789156112.377419`. |
| Stable retries and delivery states | Production receipt refresh above; sandbox duplicate/conflict cases and app native/browser checks across reload, edits, queued/delivered/parked states. |
| Auth, unavailable ingress, oversized input, ambiguous transport and invalid receipts | Focused native/API/browser checks; Concierge's full gate passed 1,188 tests. These failure paths were not induced in production. |

Sandbox run `20260911T192932Z-2525816-28807` loaded the clean Concierge commit
above and was released after zero unsettled work. Its durable evidence remains
under that run's `evidence/thinkering-slack.json` and `thinkering-app-menu.json`.
Thinkering's corresponding cases are `tests/slack-capture.test.mjs` and
`apps/web/tests/production/send-to-slack.spec.mjs` in its repository.

### One-click app correction (deployed)

Thinkering release `5763024e981f8cc30357e9dec43507e6b2f62bac` removes the manual
Check Slack delivery action. The original Send stays Sending while bounded
automatic refresh repeats the frozen event ID and text. Only `delivered` produces
Sent; `parked` stops with an attention message, and deadline/network ambiguity
remains unconfirmed with frozen-snapshot retry. No ingress change was required.

The app owner reported all 19 release checks and 604 browser executions passing
for immutable verification run `08fb2ffe-0b66-4291-b3b9-c61f464cc346`, with source
fingerprint `9e8ca4db6993f5db24f014208847ed4c2dfb0713eb523c81bcddfef821a1f14b`
unchanged before/after verification. Fresh backup and idle checks preceded
activation through the existing deploy entrypoint; the current release pointer
was independently checked against that exact commit.

The retained app receipt at
`/root/workspace/thinkering/.wt/send-to-slack-feedback/.artifacts/slack-feedback-live/live-check.json`
confirms that build on public HTTPS, owner login, anonymous refusal (`401`), row
menu, command palette and matching update-worker bytes. Its Chromium viewport
was 1280×800 and it sent zero capture requests. The app owner also verified the
loaded credential against its source at mode `0400` without exposing values.
No known app defect remains from this request.

The app owner added native proof that long UTF-8 selections reach ingress as one
complete request without splitting or truncation. That and Concierge's retained
real Slack file-byte/single-input proof establish the components separately:
the combined long app-menu-to-Slack-file journey was not exercised as one run.
Production nested/long/failure cases were not injected. The original production
event above remains the live text and duplicate-refresh proof; new media formats
are outside this text-snapshot contract.

## Initial activation blocker (resolved)

The 2026-09-11 independent implementation review confirmed that the pre-change
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
blocker; the authorized source rollout completed with the durable health proof
recorded above. This historical exception does not change normal push-driven
deployment ownership. Sandbox evidence must never be relabeled as production
readiness.
