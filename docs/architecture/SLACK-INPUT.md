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

## Inline capture

Once capture eligibility is durable, every retry enters one capture worker keyed by channel and Slack timestamp. Vault and Slack List completion are separate persisted substates. Vault entries and List source links use authenticated markers; List recovery additionally verifies title shape and authenticated bot ownership.

First List creation persists a random intent before Slack, finalizes an HMAC bound to channel, returned List ID, and intent, then persists identity before granting access. The saved List identity is also the access-repair marker. Startup repairs access, scans every files page, and may adopt only a bot-owned candidate whose pending or finalized marker validates for the exact durable intent.

Transient Slack and SQLite failures remain retryable. Permanent List capability, permission, or contract failure becomes an explicit skipped secondary sink. Capture completes only after the vault sink is done and the List sink is done or explicitly skipped. Its confirmation owns a separate durable lease and deterministic Slack message ID. Inline capture never falls into the generic resend path.

## Channel Canvas projection

Canvas synchronization is one-way from the canonical instruction file to Slack. `bot/src/canvas.ts` renders the complete file with a freshness footer, creates or updates the stored Canvas, adopts the first existing channel Canvas tab if local state lost its ID, and deletes extras. Slack-side edits are not read back and may be overwritten; the Web API does not expose a deterministic raw-document read path for bidirectional synchronization.

Managed projects read `<code_path>/AGENTS.md`, the real git-tracked authority. Vault-only channels with `code_path=NULL` fall back to `<vault_path>/AGENTS.md`. The source path participates in the fingerprint, so a code-owned instruction edit triggers refresh and a path change cannot reuse a stale projection.

Refresh runs during channel-surface creation, startup, every six hours, and after turn completion or failure when the fingerprint changes. Canvas iteration uses the Slack-visible channel query and excludes registry-only adoption rows whose `slack_channel_id` is null. Normal startup and scheduled refresh tolerate per-channel failures and log them.

A managed-project scaffold cutover persists `blocked` state before mutation; startup refuses that state before abandoned deployment-drain recovery. After filesystem and Git gates complete, state advances to `canvas_required`: startup preserves the drain, must refresh every Slack-visible channel, and only then calls `app.start` and publishes `concierge_bot_online`. The deploy wrapper removes cutover state only after functional health and gate release; a failure retains state for explicit recovery. The manifest supplies `canvases:read` and `canvases:write`; scope changes remain manifest-first.

Authority: `bot/src/canvas.ts`, callers in `bot/src/index.ts` and `bot/src/turn-execution.ts`, scaffold ownership in `bot/src/channel.ts`, and `bot/tests/canvas.test.ts`.

## Slack links, attachments, and audio

Pasted Slack permalinks are hydrated with `conversations.replies`; reply permalinks resolve through `thread_ts`. Inaccessible links produce readable context errors rather than failing the turn. Existing history scopes are sufficient; do not add app-unfurl or link-specific scopes.

Slack files count as user content even when text is empty. Downloads live in a turn-scoped attachment directory and are deleted after the turn. Non-audio attachment history is therefore intentionally unreplayable.

Audio uses a usable Slack transcription first and otherwise the pinned local `whisper.cpp` runtime with the `base.en` model. Deploy installs it idempotently. The upstream container is not used on AX41 because its published binary requires AMX. Runtime overrides are defined in `bot/src/transcription.ts`, threads are capped at eight, and transcription failure fails the turn rather than discarding an audio-only message.

Authority: `bot/src/slack-links.ts`, `bot/src/attachments.ts`, `bot/src/transcription.ts`, and their focused tests.
