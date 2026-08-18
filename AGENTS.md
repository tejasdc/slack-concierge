
## Response format

Every final agent response delivered through Concierge starts with `TL;DR:` and a concise summary, followed by the full detailed response. The TL;DR is cumulative for its visible Slack thread: each completed turn replaces it with an end-to-end summary of every request and delivered agent outcome in that thread through the current turn. Concierge injects the prior durable summary into each provider turn and also enforces the prefix before final Slack delivery. Provider progress commentary is never mistaken for the final response: Codex uses its `final_answer` phase and Claude Code uses its terminal result when available.

Every admitted agent turn immediately posts its own status reply in the visible Slack thread. That reply—not the thread's top status—receives the turn's elapsed time, provider-activity age, and tool count every 30 seconds, then terminates as that turn's done or error status. A later post-completion request gets a new status reply; a reply received while the provider is still live remains mid-turn steering and keeps the explicit steering acknowledgement path. The static hourglass reaction on the triggering user message remains a separate at-a-glance processing indicator. Terminal turn transitions atomically enqueue its removal; a durable retry worker removes it without delaying response delivery or lock release, startup reclaims interrupted cleanup leases, and a persistent transient Slack failure parks the cleanup after its bounded attempt count.

The first turn's status reply has a second role: it is the visible thread's one durable cumulative TL;DR message. On the first turn, the per-turn status and cumulative summary are therefore the same Slack message. On every later turn they are distinct: live heartbeats and the terminal turn summary stay beside the new request, while the first status reply retains the last delivered cumulative TL;DR until response delivery becomes durable. A completed turn records its own response TL;DR and atomically advances the thread's summary cursor only after durable response delivery; only then does the first status reply receive the new end-to-end TL;DR. The thread projection persists that first turn as its anchor, and startup backfills the anchor for pre-anchor rows from their exact shared Slack timestamp and proven visible thread. If Slack deletes the dual-purpose message, either projection atomically clears both pointers, the anchor turn recreates it once, and the thread projection reuses that replacement instead of posting a second summary message.

Both terminal turn status and cumulative summary delivery are durable ordered projections, not best-effort post-delivery edits. Every turn persists its own status timestamp, desired terminal revision, pending/sending/delivered/parked lifecycle, and message generation; the visible thread separately persists the equivalent projection state for its first cumulative status reply. The 30-second heartbeat is intentionally ephemeral and lossy, but once a turn terminates its final status is retried or explicitly parked before the provider-session lock is released. Startup reclaims interrupted projection writes before reconciling orphaned running or delivering turns. Projection bookkeeping must never replace a turn's `slack_bot_msg_ts` with the thread summary timestamp. Response delivery is monotonic: after Slack delivery is durably confirmed, later turn-status or cumulative-summary failures park only their own projection and can never demote the response to `delivery_parked`. Before confirmation, unexpected failures relinquish the pending delivery for startup recovery; only an explicit permanent Slack delivery outcome parks it. Parking a permanent delivery, requesting its terminal status, queuing hourglass cleanup, and releasing its provider-session lock are one SQLite transaction, so a crash cannot expose a terminal turn with a stale working status. Message creation uses a deterministic `client_msg_id` bound to the persisted turn-or-thread identity and generation: an ambiguous create retries the same generation, while proven deletion (`message_not_found`, `cant_update_message`, or `duplicate_message_not_found`) advances to a fresh generation. Permanent response-delivery failure terminates the affected turn status without advancing the cumulative response summary.

Turn lifecycle code follows these ownership boundaries. `index.ts` owns Slack ingress, admission, and routing. `turn-execution.ts` coordinates an admitted turn through context preparation, provider execution, delivery, and durable completion. `turn-status-controller.ts` owns only the current turn's ephemeral heartbeat and terminal status. `thread-status.ts` plus the thread-status state transitions own only the durable cumulative projection. `turn-list-effects.ts` owns List collaboration around a turn. An uninitialized `single-persistent` channel uses one deterministic hidden session key, independent of the triggering visible thread, so concurrent first messages contend on the same session lock; the first provider UUID is then bound with compare-and-set semantics. Extend these components at their existing boundary instead of adding another lifecycle branch to `handleUserMessage`; any lifecycle change requires a focused state-transition test and a multi-turn test proving that later heartbeats cannot overwrite the first cumulative status.

Legacy threads lazily adopt their earliest status reply and synthesize request/outcome pairs on their next turn. Concierge reads the current Slack thread's message timestamps to associate old replies with their proven visible thread. In `single-persistent` channels, unresolved legacy turns never fall back to the shared provider-session anchor; losing an ambiguous old summary is safer than contaminating another top-level Slack thread.

## Provider aliases

Provider/model selection is data, not parser logic. `bot/src/aliases.ts` is the only source of truth for text aliases, channel defaults, dispatch overrides, and comparison defaults:

| Alias | Provider | Model |
| --- | --- | --- |
| `@cc` | `claude-code` | CLI default |
| `@cc-fast` | `claude-code` | `claude-haiku-4-5` |
| `@cc-medium` | `claude-code` | `claude-sonnet-5` |
| `@cc-fable` | `claude-code` | `claude-fable-5` |
| `@cx` | `codex` | CLI default |
| `@cx-fast` | `codex` | `gpt-5.6-luna` |
| `@cx-medium` | `codex` | `gpt-5.6-terra` |

Selectors match case-insensitively, with start-of-text or whitespace before `@`, an exact provider-valid suffix, and a word boundary after the complete alias. Unknown suffixes, provider-invalid tiers, and alphanumeric bleed are complete non-matches: they neither switch provider nor get stripped. Only the first top-level message can bind a thread, and bare aliases omit `model` so provider CLIs keep their own moving defaults. `@claude-code` is not a text alias.

## Agent comparisons

The `Compare with another agent` message shortcut is the A/B-testing surface. It opens a modal with a provider choice (`codex` or `claude-code`) only. The other provider is selected by default, and each provider runs with its bare provider alias default (`@cx` or `@cc`) from the alias table.

Comparisons always start a fresh provider session in a new top-level Slack thread, including in channels configured for `single-persistent` sessions. Concierge resolves the clicked message to its exact owning turn (including final delivery chunks), while the visible thread's cumulative first status resolves through its current durable summary cursor rather than its original first turn. It reads that session's persisted canonical replay text in chronological order through the selected boundary, deliberately excludes every `agent_text`, and sends the resulting user-only history as one clearly delimited comparison prompt. The final replayable user entry is the active request; earlier entries are context. Turns cancelled before reaching a provider are omitted, and selecting such a turn is an explicit error rather than silently falling back to an earlier request. This path does not fork or resume the original provider session, because either would leak the original agent's hidden conversation state into the comparison.

Canonical replay text includes hydrated Slack-link context and completed audio transcripts. The comparison wrapper is a prebuilt provider input: it bypasses ordinary mention stripping, skill selection, inline capture, and Slack-link hydration so stored context is neither mutated nor fetched again. A turn becomes replay-ready only when that canonical input is persisted and the provider reports that it started; raw Slack `user_text` is never a fallback. Histories containing an in-flight or preprocessing-failed turn, a turn interrupted before provider start, or a legacy turn from before canonical replay storage are rejected because the original provider input cannot be proven. Non-audio files cannot yet be reproduced faithfully after the original turn's temporary files are deleted, so any history containing one is rejected with a visible error. Provider prompts are written over stdin rather than placed in process arguments, so long histories do not encounter the host's argument-size limit; stdin failures are captured as turn errors rather than process-level failures.

Comparison agents retain normal tool permissions and can modify the same project. The modal warns about that behavior rather than silently switching the run into a read-only mode, which would make it a different test. Modal submission claims a durable request row keyed by Slack's view ID before creating the comparison thread; retries return the existing request instead of launching another full-power agent. The request records its provider turn ID before invocation. A request reaches `done` only after its turn is durably delivered; drain refusal, provider failure, stopped delivery, and parked delivery leave an explicit error status. Startup reconciliation joins nonterminal requests back to their turns so crashes after claim, during the provider, or between delivery and request completion cannot strand an ambiguous request. Registering or changing the shortcut is manifest-backed: update `slack-app-manifest.json`, upload the manifest, and reinstall the Slack app. No additional OAuth scope is required for this shortcut or its modal.

## Mid-turn steering

A user reply in the same visible Slack thread steers that thread's agent while its provider turn is live. Live-target routing precedes drain, inline-capture, skill, and channel-mode admission, so unmentioned replies and command-shaped guidance are not swallowed while a turn is active. Steering is keyed by Slack channel plus reply-thread timestamp, not merely by the persistent provider session: in a `single-persistent` channel, a new top-level message must never redirect an unrelated in-flight thread. If no live target exists, ordinary turn admission and busy handling apply.

Concierge registers the live steering target immediately after it acquires the turn lock, so replies that arrive during attachment, Slack-link, or List preprocessing queue in order and flush once the provider transport is ready. Each steering reply is persisted with its visible Slack reply-thread timestamp and reserves its queue position synchronously before Slack-link hydration; canonical preparation is serialized inside that queue and updates the durable replay text before provider delivery. Canonical history uses durable turn/steering insertion order—the order actually presented to the provider—not Slack timestamp order. Codex runs through its bidirectional App Server protocol and sends `turn/steer` with the active Codex turn ID as a precondition. Its JSON-RPC response must name that same turn, and the matching user-message notification may arrive before or after it, so Concierge correlates the input by `clientUserMessageId` and opens the replacement output segment at whichever boundary is observed first. Claude Code runs with `--input-format stream-json --replay-user-messages`, keeps stdin open, and becomes provider-started and replay-ready only after the exact initial user-message replay—not arbitrary stdout or its init event. For steering, Concierge sends the supported `control_request`/`interrupt` before the replacement user message and treats both the successful control response and exact echoed user-message event—not pipe writes—as provider acceptance. An interrupted Claude result is an intermediate turn boundary even if it arrives after the replacement replay: Concierge keeps the steering target and stdin open until the replacement turn's non-aborted result, and excludes superseded partial assistant text from the final reply. Claude replay events have no client correlation ID; if a written guidance message times out or its write becomes uncertain, Concierge permanently refuses further steering on that provider stream so a late replay can never acknowledge a later identical Slack message. When a non-aborted result races a written but unacknowledged replacement, Claude gets a short replay grace period; expiry reports provider terminality before rejecting that guidance or beginning child teardown. Each transport synchronously reports its terminal protocol event so the target is removed before child-process teardown, Slack delivery, or Canvas work; a late message cannot be falsely acknowledged as steering a completed agent.

Steering messages are stored in `turn_steering_messages`. Before routing or side effects, every Slack user event first acquires one channel-wide row in `slack_user_input_claims` with a per-handler token and its complete recovery envelope: visible reply thread, user, text, and file metadata. Capture eligibility is deliberately false in this unclassified envelope. Only after exact live-thread steering and drain routing have both declined the message does Concierge durably transition a command-shaped input into capture recovery; a crash before that decision can therefore request a resend but can never turn intended steering into vault/List side effects. Bolt acknowledges message events before the listener runs, so transient SQLite contention at this reservation boundary is retried without an age limit; the acknowledged handler remains part of drain ownership until the claim is durably classified. The winning handler then permanently classifies that timestamp as a turn, steering, capture, ignored, or drain-rejected input; concurrent Slack retries cannot duplicate captures, cross provider turns, or change classification as live-target timing changes. A drain rejection atomically queues its resend notice in that same classification transaction, for both the process-local shutdown gate and the database deployment gate. The notice uses a deterministic Slack message ID and the durable notice worker, so a failed post or crash before delivery is retried after restart instead of silently losing an acknowledged request. If a handler fails before classification, its token-guarded claim becomes a durable ignored row with a pending recovery notice instead of being deleted. Startup does the same only after proving the exact process owner stale, then asks the user to resend in the original visible thread.

Inline captures are the exception to that generic resend path: once capture eligibility is durable, the original handler and every retry enter the same worker keyed by channel plus Slack message timestamp; no capture sink runs outside that worker. Startup first completes any dead owner's capture from its durable envelope. Vault and List completion are separate persisted substates. Vault entries carry an HMAC-authenticated Slack-message marker. Each List row's source link carries an HMAC bound to the channel, concrete List ID, source type, exact Slack permalink, and captured title; reconciliation also requires the expected title field shape and authenticated bot creator, so a public permalink in an unrelated row cannot suppress the intended write. Same-process List appends for one authenticated source identity are serialized, closing the read-before-create race between a live event and its Slack retry. First-time channel List creation persists a random creation intent and start time before `slackLists.create`. The create request carries an HMAC-authenticated pending marker for that intent; after Slack returns the List ID, Concierge uses `slackLists.update` to bind a finalized HMAC to the channel, concrete List ID, and intent, then persists the returned ID before granting channel write access. The persisted List identity is also the durable access-repair marker: every cached use idempotently reasserts `slackLists.access.set`, transient failures remain live-retryable, and startup schedules an exponential-backoff repair for every cached List. A crash or transient failure after local identity persistence can therefore never strand a permanently unshared List. Startup or live retry can recover a pending bot-owned candidate only for the exact durable intent and only when Slack says it was created after that intent began; it can recover a finalized candidate only when its ID-bound marker validates. Discovery scans every files page and adopts the oldest valid candidate. A visible finalized marker copied to any other List fails because the destination List ID changes, while a stale replacement records a new intent and never re-adopts a List from the older intent. Legacy public and channel-only markers are never adopted. The bot completes `auth.test` and records the owner identity before startup recovery or accepting Socket Mode events. This closes both remote-create/identity-update and identity-update/local-persistence crash windows without relying on a nonexistent Lists idempotency argument. A cached List that Slack reports deleted or with stale column metadata is conditionally cleared with transient SQLite retry semantics, rediscovered or recreated, and authenticated row reconciliation runs again before item creation. Transient List or SQLite failures leave the capture pending for live exponential-backoff and startup recovery; permanent List capability, permission, or contract failures are persisted as an explicitly skipped secondary sink instead of looping forever. Concierge classifies the input as a completed capture only after the vault sink is done and the List sink is done or explicitly skipped. Capture confirmations have their own durable lease/retry state and deterministic Slack message IDs, closing the crash window between capture completion and acknowledgement. Inline captures never enter the generic resend path. The database deployment gate is checked in the same transaction that classifies a token-backed ordinary turn, so a handler that began before a drain cannot enter afterward.

A steering row moves `queued → sending → sent`. `sending` is persisted before provider delivery, and `sent` is persisted before the controller settles the input in memory. SQLite uses a busy timeout and steering transition callbacks retry lock contention, so an external writer cannot strand a provider-accepted message. Because provider acknowledgement and SQLite cannot form one atomic transaction, a crash or completion race while `sending` becomes `ambiguous`, never `failed`: ambiguous guidance may have changed hidden provider context and is therefore excluded from canonical replay, comparison, and fork histories. A later acknowledgement can safely upgrade it to `sent`. Startup reconciles unsettled steering independently of the parent turn's phase: after proving the exact owner dead, `queued` becomes failed and `sending` becomes ambiguous even if the turn already advanced to delivery or a terminal state. A still-live exact owner is never preempted. Comparisons reject all in-flight source turns as well as ambiguous steering.

Failed or ambiguous steering owns a durable pending failure notice. Delivery first atomically leases the notice, then posts with a deterministic Slack `client_msg_id`; a concurrent retry cannot become a second sender, and an interrupted lease is recovered on startup. Slack delivery and its following SQLite transition are separate error boundaries: only errors thrown by the Slack call are classified for retry or permanent parking. Transient Slack failures are durably rescheduled with exponential backoff by a live worker; transient SQLite load, claim, and transition failures are retried by that same live worker instead of requiring a restart, while non-transient persistence errors still fail loudly and can never reclassify an already-posted notice as a permanent Slack rejection. Permanent Slack failures are explicitly parked. The input-recovery notice uses the same lease/retry mechanism. Ambiguity notices remain `deferred` until the provider acknowledgement promise definitively rejects, so a late acceptance upgrades the row to `sent` without racing a contradictory warning; startup promotes old deferred rows only after the former provider process is gone. General Slack message ownership resolution includes accepted steering for comparison replay. Provider-session forks reject direct steering replies, live/delivering source sessions, and every source session containing queued, sending, or ambiguous steering because neither provider can clone a proven point-in-time boundary from that hidden session. Comparison resolution can identify unaccepted steering solely to return an explicit non-replayable error. Steering is currently text-only. A steering reply with any file is durably classified, marked failed, and rejected with a file-specific visible notice; never discard or defer an attachment silently.

Provider children have protocol-liveness boundaries so a silent process cannot retain a session lock or block a drain forever. Codex JSON-RPC admission calls time out after 30 seconds and both transports terminate after 30 minutes without a parsed provider protocol event; malformed stdout and stderr chatter do not extend the lease. Claude's valid `keep_alive`, `tool_progress`, `tool_use_summary`, and `stream_event` frames renew that lease without changing steering or output state. A Claude child is successful only after an exact initial prompt replay and a final non-aborted `result`; partial assistant output followed by any process exit is an error, while a child force-terminated after emitting its final result remains complete. Graceful input closure escalates from `SIGTERM` to `SIGKILL` when a child ignores shutdown, and transport completion waits for proven child exit. These are liveness limits, not overall turn-duration caps: every recognized provider protocol event resets the inactivity timer. The recurring process-instance heartbeat is serialized and retries transient SQLite contention; timer callbacks catch and log terminal failures so an interval rejection cannot crash the bot while an acknowledged Slack ingress claim is still being persisted. Scheduled Canvas refreshes likewise catch their asynchronous failures.

## Slack app scopes

**Every change to OAuth scopes MUST go through the manifest file (`slack-app-manifest.json`), never via the Slack UI directly.** Any scope added by hand in the App Config UI creates drift between what the running install has and what the repo declares — a subsequent Reinstall on the (stale) manifest silently strips the manual scope, and features that depended on it break with no obvious trace. Manifest-first keeps the repo as the source of truth and makes scope changes reviewable in git.

- To add or remove a scope: edit `slack-app-manifest.json`, commit, upload the file at https://api.slack.com/apps/A0BNG0WHUNQ/app-manifest, click Reinstall, grab the new tokens on the OAuth & Permissions page and update `/root/.config/concierge/slack.toml` on AX41.
- After every reinstall verify with the `X-OAuth-Scopes` header (via `auth.test`) — the granted set must exactly match `slack-app-manifest.json`. If it drifts, fix the manifest first, then reinstall.
- Never edit scopes in the UI as a shortcut, even for a "small" one-liner — the drift compounds.

## Slack permalinks

Agents should be able to read Slack thread links pasted into a turn without asking the user to copy messages manually. Concierge parses `https://*.slack.com/archives/<channel>/p<timestamp>` links from message text, resolves reply permalinks through `thread_ts` when present, and hydrates the linked thread with `conversations.replies` before invoking the provider. The resolved thread is prompt context only; inaccessible links are surfaced as readable context errors rather than failing the whole turn.

This path uses the existing history scopes (`channels:history`, `groups:history`, `im:history`, `mpim:history`). Do not add app-unfurl domains or Slack link scopes just to read pasted Slack permalinks; normal message events already carry the URL text, and Web API history methods are the authoritative retrieval path.

## Audio clips

Slack audio clips arrive as ordinary message file objects. The message text can be empty, so routing must treat attached files as user content. `files:read` is sufficient to retrieve the private media URL; no audio-specific Slack scope is required.

Concierge downloads each clip into its turn-scoped attachment directory. It uses Slack's file-object transcription when usable and otherwise transcribes locally with the pinned `whisper.cpp` runtime at `/root/.local/share/concierge/whisper.cpp` and the `base.en` model at `/root/.local/share/concierge/whisper-models/ggml-base.en.bin`. `bot/scripts/install-transcriber.sh` installs `ffmpeg` and build tools, builds the pinned runtime for the host CPU, and downloads the model. Deploy runs this installer idempotently before restart. Do not use the upstream container image on AX41: its published binary requires AMX and exits with `SIGILL` on this CPU.

Runtime overrides are `CONCIERGE_WHISPER_BINARY`, `CONCIERGE_WHISPER_MODEL`, `CONCIERGE_WHISPER_THREADS` (capped at 8), and `CONCIERGE_WHISPER_LANGUAGE` (defaults to English). Audio and derived WAV files are deleted with the rest of the attachment bundle after the agent turn. Transcription failure is a turn error surfaced in the Slack thread; never silently discard an audio-only message.

## External capture ingress

External devices enter through the versioned `agent-inbox.service`, not through
machine-local webhook scripts. Caddy terminates HTTPS and proxies to the
loopback-only Bun listener on port 8080. `config/capture-routes.toml` is the
source of truth for every route's URL path, adapter, maximum body size,
systemd credential name, and destination. These flow bindings must never be
embedded in `capture-ingress.ts`.

The Pebble Index route is intentionally transcript-only. Pebble's phone app
already performs speech-to-text; sending audio to AX41 and running Whisper adds
payload and latency. The adapter accepts Pebble's multipart `transcription`,
`recordedAt`, and `client` fields and rejects audio or a body above 256 KiB.

Slack-bound captures are durable before HTTP acknowledgement in
`/var/lib/concierge-capture/state.db`. `capture_events`
owns deduplication, retry state, and the deterministic Slack `client_msg_id`.
Return `202` only after the event exists in SQLite. Every `sending` row stores
the exact delivery process identity. Startup and the privileged deployment gate
may recover it only after that PID/start-time/boot identity is proven dead;
transient delivery failures must remain live retryable, and permanent Slack
contract/auth failures must park explicitly.
Rendered messages above Slack's 40,000-character ceiling must be rejected
before persistence. Slack requests have a hard timeout and delivery concurrency
is bounded. If a worker cannot durably leave `sending`, the ingress must
terminate gracefully so systemd restart makes that lease owner provably dead;
logging and dropping the task would permanently strand both capture and deploy.

The capture database owns `capture_delivery_gate`. Claiming a capture and
claiming this gate are mutually exclusive immediate SQLite transactions. A
deployment claims the capture gate before the bot gate and refuses while a
live owner is sending. Before Concierge becomes unavailable, the gate changes
to a durable `held` mode that survives its deployment owner. It is released
only after the new Slack bot passes functional health; a later deployment may
atomically adopt a dead owner's hold. The first-rollout bootstrap must enter
held mode before ingress starts. Failure cleanup uses a live-only conditional
release in SQLite, so an ambiguously acknowledged durable hold can never be
deleted based on stale shell memory.
HTTP capture admission stays open and durable while delivery is paused.

Never log bearer values or transcript bodies. Directory-bound raw captures use
streamed same-directory temporary files, an atomic exclusive hard link, and a
content-derived filename so a 64 MiB request is never duplicated in memory and
webhook retries cannot create duplicate files.
Ingress shutdown stops accepting new requests but waits without a systemd
timeout for active uploads. The first migration from the legacy Python receiver
temporarily rejects new loopback connections with a named conntrack rule, waits
for established uploads to finish, replaces the service, then removes the rule.

The network-facing service runs as the dedicated `concierge-capture` identity
from a root-owned bundle under `/usr/local/lib/slack-concierge`, with
`ProtectSystem=strict`, `ProtectHome=true`, bounded memory/tasks, and only its
state/audio directories writable. Route auth, Slack delivery, and route config
enter through systemd `LoadCredential`. Slack delivery uses the separately
manifested Concierge Capture app's user token with exactly `chat:write`; never
copy the main app's broad token. The process never receives the bot's general
configuration file or access to the code checkout.

The historical `/audio` route and `agent-inbox.service` name are preserved for
the Watch/iPhone fallback while the untracked Python receiver is replaced. Any
capture change must keep that compatibility test, focused route-security tests,
and `docs/CAPTURE-INGRESS.md` current. Deploy creates missing route secrets
without overwriting existing values, verifies the independently provisioned
least-privilege Slack credential and its granted scopes, rebuilds the runtime
bundle, restarts the ingress, and must pass its local health probe before
restarting the Slack bot.

## Deploy

Multi-peer checkout. See global `~/.codex/AGENTS.md` "Distribution discipline" for invariants. Service peer deploys via `bot/scripts/deploy.sh` (pull + restart, refuses on conflict). Deploy installs/refreshes the primary bot unit from `systemd/`; backup infrastructure remains owned by the machine-level `remote-box` project.

Deploys are drain-aware. `bot/scripts/deploy.sh` asks the runtime-owned
`drain-status.ts` interface whether provider turns have live owners before it
pulls or restarts anything. It waits 20 minutes between checks for genuinely
live work, with no maximum age: a long-running healthy agent is never killed
just to ship a deploy. A deployment proceeds past blocking rows only when
process-instance ownership proves that every owner is stale; startup recovery
then reconciles those rows. An indeterminate liveness result fails closed.

When a deploy is requested by an agent running under `concierge-bot.service`,
the script hands the job to a transient systemd unit. Backgrounding inside the
bot service is not sufficient because systemd kills the whole service cgroup
on restart. The transient unit owns the wait, pull, and restart independently.

The primary `concierge-bot.service` unit is versioned at
`systemd/concierge-bot.service`; never edit `/etc/systemd/system` directly.
After restart, deploy requires an active service with a nonzero MainPID and a
successful Slack `auth.test` via `bot/scripts/healthcheck.ts`. A merely
"active" systemd process is not considered a successful deployment; the new
systemd invocation must also log `concierge_bot_online`.

The database-backed admission gate is introduced by the same release as the
first drain-aware deploy, so that release uses the guarded bootstrap script.
Fetch the script without changing the checkout, then execute it:

```bash
git fetch origin
git show origin/main:bot/scripts/bootstrap-deploy.sh > /tmp/concierge-bootstrap-deploy.sh
chmod +x /tmp/concierge-bootstrap-deploy.sh
/tmp/concierge-bootstrap-deploy.sh
```

It inspects the legacy service cgroup every 20 minutes. Once empty, it freezes
the complete cgroup and inspects it again, closing the race where the old bot
could accept work between inspection and stop. It then stops the frozen service
and creates a one-time, mode-600 bootstrap token. The new deploy independently
requires both an inactive service and that exact token before bypassing its
normal database gate. It then pulls and starts the drain-aware release. A pull
failure leaves the legacy service stopped. If invoked by Concierge itself, it first moves into a
transient systemd unit so stopping the bot cannot kill the bootstrap. This path
is only for the first rollout; every later deploy uses the atomic database gate.

The primary unit uses `KillMode=mixed`: graceful stop sends SIGTERM only to the
bot's main process, allowing it to wait for provider children, while a later
forced SIGKILL applies to the complete cgroup. `TimeoutStopSec=infinity` means
systemd never escalates merely because legitimate agent work is long-running;
an operator can still explicitly force-kill the unit when investigation proves
the work is irrecoverably stuck.

## Adopted channels with custom vault_path

Most channels get scaffolded through `/create-channel` (or `bot/scripts/adopt-project.sh` at migration time) and land in the standard shape: `code_path=/root/workspace/<slug>/`, `vault_path=/root/workspace/vault/projects/<slug>/`. A few are registered by hand-inserting a `state.db` row with a non-standard `vault_path`—always for vault-only content workspaces that have no code side.

Current instances:

- **`#blogs`** — `vault_path=/root/workspace/vault/blogs`, `code_path=NULL`. Vault-only writing workspace (writing-process AGENTS.md + per-piece prose, no code repo). Escalation to a real code project uses `/create-channel <name>` as normal; the new project's AGENTS.md gets a pointer back to the matching `vault/blogs/<piece>/` folder. See `/root/workspace/vault/blogs/AGENTS.md` for the workspace's own doc.

How to register: single `INSERT INTO channels (slack_channel_id, slack_channel_name, vault_path, code_path, provider_default, mode) VALUES (...)`. The concierge honors any `vault_path`—regular messages fire an agent turn with `cwd=vault_path`, and the explicit-capture path (`appendInbox` in `bot/src/channel.ts`, triggered by `/note`, inline `note:`, or the "save to inbox" message shortcut) resolves to `vault_path + "notes/inbox.md"`. There's no hardcoded `projects/` prefix in either path—a NULL `code_path` is fine when the workspace has no code side.

## Backups

Backups are a machine-level concern — see the `remote-box` repo (`/root/workspace/remote-box`), which snapshots the whole `/root`, `/etc`, and `/var/lib` trees to a Hetzner Storage Box. That includes `/root/.local/state/concierge` (bot state), `/var/lib/concierge-capture` (capture queue), `/etc/concierge`, and everything needed to rebuild. slack-concierge itself owns no backup scripts.

Restore state.db from restic: `/root/workspace/remote-box/scripts/restic.sh restore latest --target / --include /root/.local/state/concierge/state.db` then `systemctl restart concierge-bot`.

Restore the capture queue: `/root/workspace/remote-box/scripts/restic.sh restore latest --target / --include /var/lib/concierge-capture/state.db` then `systemctl restart agent-inbox.service`.
