# Thinkering capture contract

Concierge owns authenticated capture intake and durable delivery to the common
native Inbox session. Human input 1789508446.918989 supersedes the Slack DM
destination and gesture split: all new Pebble transcripts, Thinkering captures
and bug reports enter this Inbox. The Inbox interprets explicit verbs such as
“take a note”, “take action” and “ask ChatGPT”; ambiguous prose asks for clarification.
Transport does not classify intent or create another router/session ledger.

## Public producers

- Thinkering: POST https://capture.tejas.nyc/thinkering with its server-side Bearer key and
  application/json, for "Send to Inbox" selections and bug reports. The drop-off keeps them
  safe while Concierge is down; they went straight to Concierge for one day (2026-09-23) and
  failed whenever it was down, so they came back here.
- Pebble: POST https://capture.tejas.nyc/pebble with the Bearer key held by the Pebble phone
  app, and multipart/form-data transcription, recordedAt (Unix milliseconds), and optional
  client. Every gesture and headerless request has the same destination. Trigger
  and version headers remain provenance, never intent or destination.
- The /audio binary receiver retains its directory-backed transport.

Thinkering request:

```json
{"event_id":"thinkering-<snapshot SHA-256>","text":"<complete original text>","kind":"bug_report","attachments":[{"filename":"screenshot.png","contentType":"image/png","dataBase64":"<canonical base64 bytes>"}]}
```

Ordinary selections omit kind and attachments. Reports freeze complete description,
timestamps, report ID, diagnostics and ordered screenshot filenames, types and bytes. The
ingress also accepts a device key stored as `sha256:<hex>`; the installer never converts one.

### Agent test deliveries

Every door above records its sender as Tejas. An agent that needs to test a path end to end
uses its own entrance, which runs the same pipeline and records the agent:

```
router-actions.sh test-capture --path <path> --source-input <id> --source-run <id> [--reply-to concierge:N] -- <text>
```

Paths: `send-to-inbox`, `bug-report`, `pebble` (this drop-off), `iphone-share`,
`action-button`, `watch`, `mac` (thnkr.ing's device route, with the agent test device key
thnkr.ing keeps at `THINKERING_AGENT_TEST_KEY_FILE`), `notification-reply` (thnkr.ing, into
`--reply-to`), and `monologue` (the owner socket). The agent's own accepted input and run travel
as `X-Concierge-Agent-Source: <input> <run>` on the drop-off and thnkr.ing, and as
`source.metadata.agentSource` or `agentSource` at the owner. The owner (`agentTestSource`)
records the capture with origin agent and that source, shows it in the Inbox under the agent's
name and starts no Inbox turn; a reply is an agent input to its session. Naming a run can only
label something as an agent's, never as his. thnkr.ing refuses its agent test key without the
header.

His own messages show the door they came through ("You · iPhone Action Button", "You · Mac
quick capture", "You · Pebble", "You · web", "You · web (password)"), derived by the owner from
the capture's recorded source or the door thnkr.ing names for its own screens.

## Durable receipt

New durable intake returns 202; an identical duplicate returns 200:

```json
{"accepted":true,"event_id":"<internal capture ID>","duplicate":false,"status":"queued","destination_kind":"session","terminal_receipt":null,"session_id":null,"trigger":null,"webhook_version":null}
```

After delivery, terminal_receipt is the canonical accepted Inbox operation/input
ID and session_id is the Inbox session. Delivered proves native admission, not
completion of requested work. Existing session history/operations show later work.
Queued means retained awaiting admission; parked requires operator inspection.
Repeat identical requests to resolve lost responses or refresh receipts. Never
mint replacement IDs for uncertain delivery.

The first accepted destination remains immutable. Previously accepted Slack or
journal rows retain their original receipts after configuration changes. No
historical publication is replayed automatically; parent-owned archival imports
and subsequent assignments are separate.

Public ingress retains text, attachment snapshot and source metadata in the
existing capture row before acknowledgment. The trusted worker alone calls
SessionOwner.acceptInboxCapture with source kind/id/time, original text and file
bytes. source.id is the capture event_id. Metadata retains route, client, trigger,
version and the original Thinkering report event_id. The same row stores returned
session/input IDs. Public ingress receives no direct session/provider authority.

## Local producer boundary

Monologue uses existing root-private /root/.local/state/concierge/requests.sock
and trusted POST /sessions/v1/inbox:

```json
{"source":{"kind":"monologue","id":"<exact note_id>","recordedAt":"<original ISO timestamp>","title":"<original title>"},"text":"<complete transcript>","files":[]}
```

Filesystem custody authenticates this producer; there is no new token or queue.
The owner returns inbox {sessionId,address}, item
{captureId,inputId,sessionId,source,text,attachments}, and operation with the same
canonical input ID. Exact source/content retries retain that receipt; changed
bytes conflict. The session-owner contract owns importOnly and source-bound note
saving. Monologue preserves its existing seen/order and uncertain Slack records,
rather than resending those records into the Inbox.

## Configuration and recovery

config/capture-routes.toml declares session destinations for both text adapters
and removes gesture destinations. Loading old controller configuration also
normalizes new text-adapter destinations to session: the immutable deployment
controller can install previous config during the first rollout. Accepted-row
lookup precedes destination selection, preserving old accepted destinations.

The existing capture table gains source_snapshot_json, session_id and
session_input_id. Its delivery_kind CHECK gains session through a transactional
table copy preserving all rows and explicit indexes, followed by updated
validation triggers. No second queue or session ledger is introduced.
After a native delivery owner is proven dead by exact process identity, its
capture returns to pending and repeats the same idempotent native acceptance.
Old Thinkering Slack ambiguity still parks. Native delivery needs no Slack
authentication; legacy Slack delivery validates credentials only when claimed.

Credentials, public allowlist and deployment remain their existing owners.
Push integrated source through the normal Git channel and end the provider turn.
Do not restart services, wait on deployment, run tests, sandbox captures or reviews.
Tejas owns live testing.

## Historical evidence

The records below describe former Slack behavior only. They neither prove native
Inbox acceptance nor authorize retired tests or deployment commands.
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
