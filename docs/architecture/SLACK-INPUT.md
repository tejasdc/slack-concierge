# Slack input, steering, and channel surfaces

This document describes ownership of Slack user input after event acknowledgement, including mid-turn steering, inline capture, Canvas projection, links, and files.

## Durable input classification

Every Slack user event first claims one `slack_user_input_claims` row with a handler token and complete recovery envelope. Capture eligibility starts false. Exact live-thread steering and deployment drain routing are decided before a command-shaped input can become capture-eligible. The winning handler permanently classifies the timestamp as a turn, steering, capture, ignored, or drain-rejected input; retries cannot duplicate work or change the classification as live state changes.

Bolt acknowledges events before its listener finishes, so SQLite contention at reservation retries without an age limit. Drain rejection queues a deterministic resend notice in the classification transaction. A pre-classification failure becomes a durable ignored claim with a pending recovery notice; startup does the same only after proving the exact process owner stale. The database deployment gate is checked in the transaction that classifies an ordinary turn.

## Mid-turn steering

A reply in the same visible Slack thread steers its provider while the turn is live. Routing is keyed by Slack channel and visible reply-thread timestamp, not merely by persistent provider session. The target is registered immediately after turn-lock acquisition, so replies received during attachment, link, or List preprocessing queue in durable insertion order.

Provider acceptance is protocol-level, never inferred from a pipe write:

- Codex sends `turn/steer` with the active turn ID and correlates its response and user-message notification by client message ID.
- Claude sends `control_request`/`interrupt` before the replacement user message. Both the successful control response and exact replay event prove acceptance. An aborted result is intermediate; the stream remains open for the replacement result.
- If Claude delivery becomes uncertain, further steering on that stream is refused because replay events have no client correlation ID.
- Each transport reports terminal protocol state synchronously so a late Slack reply cannot be acknowledged against a completed agent.

A steering row moves `queued -> sending -> sent`. A crash or completion race while `sending` becomes `ambiguous`, because hidden provider context may have changed. Ambiguous guidance is excluded from canonical replay, comparisons, and forks, but a late acknowledgement may still upgrade it to `sent`. Failed and ambiguous inputs own durable failure notices with deterministic IDs and retry/parking state. Steering is text-only; any attached file is durably rejected with a file-specific notice.

Authority: `bot/src/index.ts`, `bot/src/steering.ts`, `bot/src/durable-notice-worker.ts`, steering transitions in `bot/src/state.ts`, and `bot/tests/steering.test.ts`.

## Canonical TODO projection

`notes/TODOS.md` is the sole project-checklist authority. Slack Lists is a read-only outbound projection, not an input surface. Provider turns never receive List contents or control markers. The one sanctioned agent mutation boundary is the canonical file: add a top-level checklist row or extend the matching row there, using its current text rather than a cached Slack ID. The inbox router's `router-actions.sh todo-add <channel> <source-channel> <source-ts> -- <text>` helper is an idempotent canonical-file append; the former direct-List `list-add` command is retired and fails explicitly. `/todo`, inline `!todo`, and the message shortcut append the same file and return without waiting for Slack List work. The `/todo` acknowledgement echoes the captured task instead of exposing the backing file path or claiming an unproven projection result.

`bot/src/todo-file-watcher.ts` watches each canonical `notes` directory so atomic file replacements remain visible. File events and explicit capture hints coalesce per channel before entering a background projection manager; failed projections retry from the still-authoritative file without needing another edit. Startup performs a local comparison against the last durable projection and contacts Slack only for changed files, missing Lists, or the one-time read-access conversion. There is no recurring fleet sweep and no Slack-edit polling. List API methods use a dedicated rate-limit lane, so projection work cannot consume the interactive capacity used for acknowledgements, reactions, and replies.

Slack row IDs remain in checklist HTML comments only as transient projector bindings. Recreating a row or List replaces the marker, so a `Rec…` value is never a durable item handle and must not anchor origin-thread, work-thread, or provider-session identity. For a changed file, the projector reads only that channel's List to calculate outbound creates, updates, and deletes, and never imports Slack values. Unbound file rows are created and rebound to returned Slack IDs; a Slack-side edit is overwritten on the next file projection. Historical `[note]` and `[agent]` capture rows retain explicit ignored-item provenance. The last projected rows are durable, allowing unchanged startup scans to stop before any Slack call. List access is persisted as `read`, avoiding repeated access updates after the one-time conversion.

Multi-line to-do bodies are supported explicitly. The first paragraph follows the top-level `- [ ]` marker; every later paragraph is separated by a blank line and begins with exactly two spaces. Concierge folds those owned continuation paragraphs into one Slack row while preserving paragraph breaks. When captured prose begins with a backslash or Markdown control syntax such as a list marker, blockquote, fence, or HTML comment, the canonical writer adds one backslash and the parser removes it; this keeps the body round-trippable without claiming manually authored nested Markdown. An unindented paragraph is deliberately not part of the item, so malformed input cannot be silently guessed back into a task. Fenced and indented code, blockquotes, HTML blocks, nested lists, unrelated prose, and mixed line endings remain byte-preserved.

Slack row reads are fail-closed: missing scope, plan unavailability, missing List identity, schema drift, malformed rows, and corrupt durable projection state leave the canonical file untouched. A deleted or stale List is recreated once before the file is reprojected. Projection also refuses to run while a legacy root `TODOS.md` remains; the scaffold must migrate and archive it first. File installation retains the journaled atomic rename-exchange and create-only-link recovery protocol because returned Slack row IDs must be rebound into the file without losing concurrent edits. Shutdown closes watchers and drains already-started projections.

Authority: canonical append/formatting in `bot/src/todo-file.ts` and `bot/src/todo-markdown.ts`, router capture in `bot/scripts/router-todo.ts`, `bot/src/todo-file-watcher.ts`, `bot/src/todo-sync.ts`, List CRUD in `bot/src/lists.ts`, TODO state in `bot/src/state.ts`, and focused TODO/router tests.

## Inline capture

Once capture eligibility is durable, every retry enters one capture worker keyed by channel and Slack timestamp. File appends use authenticated idempotency markers. A todo capture completes when the canonical file append is durable, then schedules the independent watcher-owned projection; the old per-capture Slack List sink is explicitly skipped. An inbox note skips projection because notes are not todos.

First List creation persists a random intent before Slack, finalizes an HMAC bound to channel, returned List ID, and intent, then persists identity before granting read access. The saved List identity and access level are recovery markers. Creation recovery scans files pages and may adopt only a bot-owned candidate whose pending or finalized marker validates for the exact durable intent.

Capture confirmation owns a separate durable lease and deterministic Slack message ID. Inline capture never falls into the generic resend path, and List availability cannot delay its acknowledgement or completion because projection recovery begins from the canonical file.

## Channel Canvas projection

Canvas synchronization is one-way from the canonical instruction file to Slack. `bot/src/canvas.ts` renders the complete file with a freshness footer, creates or updates the stored Canvas, adopts the first existing channel Canvas tab if local state lost its ID, and deletes extras. Slack-side edits are not read back and may be overwritten; the Web API does not expose a deterministic raw-document read path for bidirectional synchronization.

Managed projects read `<code_path>/AGENTS.md`, the real git-tracked authority. Vault-only channels with `code_path=NULL` fall back to `<vault_path>/AGENTS.md`. The source path participates in the fingerprint, so a code-owned instruction edit triggers refresh and a path change cannot reuse a stale projection.

Refresh runs during channel-surface creation, startup, every six hours, and after turn completion or failure when the fingerprint changes. Canvas iteration uses the Slack-visible channel query and excludes registry-only adoption rows whose `slack_channel_id` is null. Canvas API calls have a dedicated rate-limit lane, so a fleet refresh cannot consume capacity reserved for user-visible Slack calls. Same-channel refreshes serialize and reload current state inside the queue, preventing an older payload or missing-ID observation from racing a newer projection. Normal startup opens Slack and capture delivery, publishes `concierge_bot_online`, and then runs its best-effort Canvas refresh without blocking functional readiness. Normal startup and scheduled refresh tolerate per-channel failures and log them.

A managed-project scaffold cutover persists `blocked` state before mutation; startup refuses that state before abandoned deployment-drain recovery. After filesystem and Git gates complete, state advances to `canvas_required`: startup preserves the drain, must refresh every Slack-visible channel, and only then calls `app.start` and publishes `concierge_bot_online`. The deploy wrapper removes cutover state only after functional health and gate release; a failure retains state for explicit recovery. The manifest supplies `canvases:read` and `canvases:write`; scope changes remain manifest-first.

Authority: `bot/src/canvas.ts`, callers in `bot/src/index.ts` and `bot/src/turn-execution.ts`, scaffold ownership in `bot/src/channel.ts`, and `bot/tests/canvas.test.ts`.

## Slack links, attachments, and audio

Pasted Slack permalinks are hydrated with `conversations.replies`; reply permalinks resolve through `thread_ts`. Inaccessible links produce readable context errors rather than failing the turn. Existing history scopes are sufficient; do not add app-unfurl or link-specific scopes.

Slack files count as user content even when text is empty. Downloads live in a turn-scoped attachment directory and are deleted after the turn. Non-audio attachment history is therefore intentionally unreplayable.

Audio uses a usable Slack transcription first and otherwise the pinned local `whisper.cpp` runtime with the `base.en` model. Deploy installs it idempotently. The upstream container is not used on AX41 because its published binary requires AMX. Runtime overrides are defined in `bot/src/transcription.ts`, threads are capped at eight, and transcription failure fails the turn rather than discarding an audio-only message.

Authority: `bot/src/slack-links.ts`, `bot/src/attachments.ts`, `bot/src/transcription.ts`, and their focused tests.

## Provider-generated output artifacts

Each admitted turn owns one exact staging directory, `<cwd>/.artifacts/turn-<turn-id>-<ownership-token>/`. The turn ID and persisted random token make the path non-reusable even after a database restore. Concierge creates it exclusively before provider execution and injects the absolute path into the provider prompt. The provider keeps the canonical project output outside `.artifacts` and copies only regular-file staging copies into the advertised directory.

The coordinator opens direct files with no-follow semantics, records device/inode/size/content hash plus the exact visible Slack destination in SQLite, and does so before response-delivery side effects. Symbolic links are rejected; files in the legacy shared root, nested directories, and sibling turn directories are never candidates. The upload worker reopens and revalidates the exact descriptor identity before giving the stream to Slack, so changing a path after registration fails closed.

Each file is an independent durable projection. Only an explicit Slack rate-limit rejection retries with bounded backoff. A permanent API rejection parks; a transport/5xx error parks as ambiguous because `files.uploadV2` offers no idempotency identity and Slack may already have accepted the file. If a process dies during upload, startup proves the owner dead and applies the same ambiguity rule. Every terminal failure appends a durable visible turn-status notice. Confirmed staging copies are removed immediately. Parked and ambiguous copies are retained for diagnosis for seven days, then the periodic finalizer removes only a staging file whose full recorded identity and content hash still match. Ignored nested entries and failed-turn staging trees are removed without following symlinks. Overlapping turns may start and finish in any order without observing one another's artifacts.

Authority: `bot/src/artifacts.ts`, `bot/src/artifact-delivery-worker.ts`, artifact tables and transitions in `bot/src/state.ts`, coordinator/startup call sites in `bot/src/turn-execution.ts` and `bot/src/index.ts`, and the focused artifact/overlap tests.
