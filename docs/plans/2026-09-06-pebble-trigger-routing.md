# Pebble gesture routing

## Decision

Keep Pebble's one configured webhook and route after authenticated ingress:

- `single-click-hold` means **preserve this thought**. Store one immutable Markdown capture in Journalmaxx's `inbox/` without creating a Slack message or provider turn.
- `double-click-hold` means **intervene now**. Preserve the existing Slack Concierge delivery, which creates an ordinary user-authored Slack message and can start an agent turn.
- `test-event` follows the Slack path so Pebble's settings test remains immediately visible.
- A request without both `X-Index-Trigger` and `X-Index-Webhook-Version` keeps the historical Slack behavior for compatibility with old clients and already configured Shortcuts.
- A versioned request must declare supported version `1` and a configured trigger. A partially versioned or unsupported request is rejected.
- A nonempty trigger not named in route configuration returns `422`; it must not silently choose an action.

This is an immediacy boundary, not a note-versus-task taxonomy. A project note, TODO, or journal thought uses the single gesture when the operator only wants to remember it. The same content uses the double gesture when the operator wants Concierge to route, transform, or act on it now.

## Durable path

The existing capture queue remains the single coordinator:

```text
Pebble request
  -> authenticated adapter parses transcript + X-Index-Trigger + webhook version
  -> route configuration resolves one destination
  -> capture_events persists source provenance and exact destination before HTTP 202
  -> trusted Concierge worker claims the event
       -> Slack delivery with stable client_msg_id, or
       -> journal file with stable event-derived filename
  -> owner-bound delivered/retry/park acknowledgement persists the receipt
```

The public `concierge-capture` process still has no Slack credential and cannot write beneath `/root`. The trusted Concierge process already owns capture side effects and writes the journal file. No new service, queue, scheduler, poller, or credential is introduced.

## Data contract

For Pebble text captures, persist:

- the existing event ID, route, transcript, recording time, and source client;
- `source_trigger` from `X-Index-Trigger`;
- `source_webhook_version` from `X-Index-Webhook-Version`;
- `delivery_kind DEFAULT 'slack'` and the selected Slack channel or opaque journal sink;
- the terminal Slack message timestamp or journal file path.

The migration retains the current non-null `destination_channel`, `message_text`, and `client_msg_id` columns so historical rows and in-flight Slack work remain readable. Existing rows receive `delivery_kind='slack'`. New journal rows store an empty channel, the same deterministic client message ID (unused), opaque `journal_sink='journalmaxx-inbox'`, and the exact canonical Markdown bytes in `message_text`. Slack rows keep the current message text and channel and have no journal sink. New nullable columns hold source headers and the kind-specific terminal journal receipt; creation and acknowledgement functions reject invalid field combinations.

The event ID remains derived from route, recording time, client, and transcript. This preserves retry compatibility across the rollout. If the same event is retried with different headers or after configuration changes, the first durably accepted provenance and destination continue to win.

The accepted JSON response and structured logs expose event ID, trigger, webhook version, destination kind, duplicate status, and terminal receipt, but never transcript text or credentials. All response and acceptance-log fields come from the canonical row returned by the insert-or-ignore operation, so a conflicting retry cannot claim that its discarded headers or destination won.

## Journal artifact

Each journal event creates exactly one file:

```text
/root/workspace/vault/inbox/pebble-<event-id>.md
```

It contains deterministically encoded YAML provenance followed by the transcript after the adapter's existing whitespace normalization. These exact bytes are rendered and persisted before `202`, so a later worker version cannot change an accepted effect.

The public row contains only `journalmaxx-inbox`, never an absolute path. Sink identifiers have immutable meanings: the production worker permanently maps `journalmaxx-inbox` to `/root/workspace/vault/inbox`; a future path change requires a new identifier while the old mapping remains available to accepted rows. The sandbox worker maps the same semantic sink to that active run's isolated journal directory. It rejects an unknown sink, a non-directory or symlink root, an escaping or unexpected basename, and a symlink/non-regular final file.

Delivery writes the persisted bytes to the exact event-owned temporary filename in the destination directory, syncs the file, installs the final name without overwriting, syncs the parent directory, removes the temporary file, and syncs the directory again before acknowledgement. Recovery may discard only that event's regular temporary file. A retry treats an existing byte-identical regular file as success only after syncing the final file and its parent directory; if it removes its event-owned temporary file, it syncs the parent again before acknowledgement. Conflicting contents or unsafe filesystem objects park the event rather than overwrite either version. The journal inbox is the capture boundary only: classification, linking, and movement into a daily note remain Journalmaxx work and are intentionally not added here.

One file is added per single-click capture; idle cost is zero. Journalmaxx or the operator retires inbox files by processing/moving them later. The existing durable capture event remains the audit record.

## Configuration

Keep the route's existing default Slack destination and add explicit trigger destinations in `config/capture-routes.toml`. Source paths, trigger values, opaque sink identifiers, and Slack targets remain data, not handler branches. Canonical Pebble configuration maps single to `journalmaxx-inbox`, double to the Concierge DM, and test events to the Concierge DM. Duplicate trigger entries and unsafe values fail configuration loading.

The header fixture is pinned to the official `coredevices/mobileapp` source contract at commit `d52101ad3d8940c5aa392d6f224e774cb6f5ce84`, which declares webhook version `1` and the three values `single-click-hold`, `double-click-hold`, and `test-event`.

## Verification

Focused tests prove:

- exact header parsing, persistence, response observability, missing-header compatibility, unknown-trigger rejection, and first-write-wins deduplication;
- single and double events accepted in order retain distinct provenance and destinations;
- atomic/idempotent journal delivery, Slack delivery, retry/park behavior, and owner-bound acknowledgements;
- schema migration preserves historical Slack rows and invalid kind/field combinations fail closed;
- route config rejects unsafe or duplicate trigger mappings;
- capture logs never include transcript text.

The sandbox controller will activate its already reserved run-local capture boundary as one controller-owned sibling using separate public-ingress and private-queue ports, run-local credentials and route configuration, the lane DM as Slack destination, and a run-owned journal directory. It starts before the bot, proves ingress and queue readiness, participates in same-run reload, and drains before release. Metadata reports `active: true` only while that exact sibling and candidate are readiness-proven.

A focused synthetic Pebble case uses the source-pinned header fixture and joins stable event IDs across ingress, the run-local SQLite database, filesystem effects, Slack inputs, provider turns, and terminal responses. It proves: single creates one run-owned journal file and zero matching Slack messages/provider turns; double creates one exact Slack message, one durable input/turn, and one terminal agent response; test-event and a headerless legacy request each take the visible Slack path; and an unknown trigger returns `422` with no row, file, Slack message, or turn. The existing `/audio` tests retain their status, content-type, size-limit, filename, and idempotency assertions. That is the automated downstream proof. A later user-initiated live-acceptance turn supplies the only remaining production-only boundary: one physical single click and one physical double click, followed by database/log and output inspection.

## Non-goals

- No AI classification at capture time.
- No automatic daily-note insertion, atomization, TODO extraction, or Journalmaxx ingest daemon.
- No second Pebble webhook or Shortcut configuration.
- No Slack message for journal-only captures.
- No production device traffic, deployment monitoring, or live acceptance in this implementation turn.

## Documentation updates

The implementation updates `docs/architecture/CAPTURE-INGRESS.md`, `docs/runbooks/SANDBOX-TESTING.md`, and the capture and sandbox invariants in `AGENTS.md` in the same commit.
