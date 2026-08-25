# Slack agent attention and progress surfaces

Status: V1 product decisions are complete and the feature is implemented in the repository for the existing Concierge app. No cloned app, user migration, channel pilot, or historical-thread backfill is required. External activation still requires the normal existing-app manifest reinstall and deployment boundary. The to-do is only a pointer to this file; the current runtime contract lives in the architecture document and executable tests. This document preserves the original requests, research, decisions, implementation plan, and raw context.

## Problem to solve

Slack should make many simultaneous Concierge sessions easy to scan and revisit. Machine lifecycle chatter must not compete with messages that need Tejas's attention. A two-hour turn still needs credible visibility into what the agent is doing, but that visibility should not create a trail of fake conversational replies or repeatedly bump a thread.

The central distinction is between four different jobs:

1. Native lifecycle state and a Stop control.
2. Useful detail about the work currently happening.
3. A durable work product at the end of the turn.
4. A strong signal that Tejas must decide, clarify, approve, or recover something.

One primitive should own each job. The design should not show the same state as a status, reaction, and reply.

## Decisions already made

- Use native Agent-session lifecycle as the in-progress signal and Stop control. Do not add `assistant.threads.setStatus` to the target design: once the default task stream exists, the older status would duplicate visible work without adding Stop or durable state.
- Treat Activity as the primary attention/navigation surface and Threads as a secondary conversation surface. Keep routing channels visible for now. Use Slack Save/Later for user-owned deferral.
- Start one app-authored progress stream in `timeline` mode by default. It interleaves provider commentary with current activity and plan progress; it remains the progress record and does not turn into the final response. Do not introduce separate quiet/live modes.
- Keep the V1 progress model literal: commentary accumulates; one `current-activity` card is replaced in place; one `plan-progress` card is replaced in place. There are no “activity epochs,” generated roll-ups, or attempts to show every provider event.
- Post the completed work as a distinct terminal reply so Slack treats completion as a new message eligible for normal thread notification. Do not mention Tejas for ordinary success.
- Mention Tejas only when human action is actually required.
- Keep the human-authored root unchanged while work is running. At completion, replace it with the provider's existing cumulative `TL;DR:`, clearly labeled as machine-managed. Do not generate a second request summary and do not truncate the original to make two representations fit.
- Keep transient plans and task activity in the app-authored stream, not in the human-authored root. Slack's native streaming API cannot append to that root.
- Adopt Slack's newer Agent/session experience directly in the existing Concierge app. Treat the manifest update and reinstall as ordinary feature configuration, not as a separate migration project.
- Slack List rows are high-level actions or pointers. This research and the raw context live here instead of continuing to expand the row.

## Slack's native primitives

| Primitive | What it is | Creates a reply? | Best job |
| --- | --- | --- | --- |
| `assistant.threads.setStatus` | A typing/loading indicator targeted by exact app identity, `channel_id`, and `thread_ts`. It supports a custom `status`, up to ten rotating `loading_messages`, explicit clearing, and automatic clearing when the app replies or after two minutes. | No | Researched compatibility primitive; excluded from the target design |
| `agents.sessions.setStatus` | A native agent-session lifecycle with `active`, `processing`, `suspended`, and `closed`. `processing` gets Slack's loading UX and can expose Stop when the app subscribes to `agent_session_stopped`. | No | Long-term agent lifecycle and user control |
| `chat.startStream` / append / stop | One app-authored threaded message that can be progressively updated with commentary, task cards, plans, or blocks. The start call returns the message timestamp used for later updates; append requires that app-owned message to remain in streaming state. | Yes, one | Default live progress record |
| Task cards and plans | Structured task IDs with progress states, details, output, and sources. The current stream reference supports `timeline` and `plan` presentation modes. | Part of the streamed reply | Major operations, plan state, and tool progress |
| `chat.postMessage` final reply | A new durable app-authored thread reply containing the provider's terminal answer. | Yes, one at completion | Completion boundary and normal Slack notification semantics |
| Root `chat.update` | Edits the root in place through the identity that authored it. It is a normal message update, not a streaming conversation. | No | Terminal cumulative TL;DR |
| `@Tejas` mention | Slack's native high-attention routing signal. | In a durable actionable reply | Decision, clarification, approval, or recovery required |
| Save/Later | Slack's user-owned follow-up mechanism. | No | Personal deferral |

Primary references: [Agent sessions](https://docs.slack.dev/ai/agent-sessions/), [Agent messaging migration](https://docs.slack.dev/ai/migrating-to-agent-messaging/), [Agent session status](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/), [native Stop event](https://docs.slack.dev/reference/events/agent_session_stopped/), [streaming API](https://docs.slack.dev/reference/methods/chat.startStream/), and [Slack's agent governance guidance](https://docs.slack.dev/ai/agent-governance/).

### What “loading text” means

`loading_messages` is not an agent telemetry feed. One `assistant.threads.setStatus` call gives Slack a static array of strings, and the client rotates through them. Slack's sample phrases are decorative. There is no automatic relationship between those strings and the operation the agent is performing.

The payload is per thread, not a one-time application setting. Every call carries the exact `channel_id` and `thread_ts`; the bot token identifies the app whose status is being set. Five or one hundred simultaneous turns therefore have independent status payloads. Concierge already persists that exact channel/thread pair on each turn, so a provider event updates only its owning thread. Within that thread, the status is dynamically controllable: Concierge can call the method again with a different `status` and a replacement set of loading messages.

If Concierge ever needed this as a compatibility bridge, it would not need `loading_messages` at all. It could set one factual `status` such as “Reading the turn lifecycle”, replace it on a meaningful provider event, and renew it before the two-minute expiry when silent. The method's documented default rate limit is 600 requests per minute per app and team. Even one renewal for one hundred quiet threads is well below that; event updates would still need per-thread deduplication and a global rate-limit lane rather than mirroring every provider delta.

Updates should be coalesced and rate-limited. A UI does not benefit from every command-output delta, and raw commands, output, secrets, or private reasoning must never be copied into Slack. The useful unit is a safe, high-level activity change.

### The newer Agent session status is different

`agents.sessions.setStatus` is not a more customizable loading phrase. It is a lifecycle model for the whole agent session. It can represent working, waiting for the user, idle/active, and closed, and it enables a native Stop control. It deliberately does not accept custom progress prose. Slack now documents this as the replacement for the older `assistant.threads.*` methods.

That trade is reasonable for the design: session status owns lifecycle and Stop; the default task stream owns detailed progress. Static “Working…” is sufficient because it no longer carries the burden of explaining the current operation. The older Assistant thread status therefore has no independent job once both are available.

A live call from the pre-feature Concierge app returned `not_authorized`. Slack's current reference defines that error as “the caller is not a member of the specified channel.” That fits Concierge's use of `chat:write.public`: the bot can post in a public channel without joining it, but an Agent session requires membership. Slack separately says only apps declared as agents can create sessions and returns `feature_disabled` when the workspace lacks the feature. The implementation therefore declares the existing app as an Agent and joins each managed public channel before opening its first session stream. Existing private channels still require an explicit invite.

Agent sessions are per thread, not one global app status. Each write carries the exact `channel_id` and `thread_ts`, so five or one hundred concurrent turns remain isolated by the same durable Slack mapping Concierge already uses. The session list shows subscribed sessions with pinned sessions first and the rest chronologically; users can pin, rename, or archive them. That is a better native navigation surface for long-lived work than manufacturing reply bumps.

### Task streaming is more than token streaming

Slack supports two independent kinds of content inside one stream:

- `markdown_text` streams provider commentary checkpoints.
- `task_update` and `plan_update` stream structured work state with stable task IDs.

The second kind is the feature relevant to Concierge. Stable task IDs can move through progress and terminal states without adding more replies; `plan` mode groups them, while `timeline` interleaves individual task cards with streamed text. Because the desired Codex-like surface interleaves narrative checkpoints and gray activity, `timeline` is the chosen default. This is much closer to the Codex app's activity view than repeatedly editing a free-form “still working” message.

Opening a stream in an ordinary channel thread creates one app-authored reply. This is a hard ownership boundary, not merely a layout preference:

- `chat.startStream` is bot-token-only and takes the human request's `thread_ts` to create the streaming reply.
- `chat.appendStream` accepts only the timestamp returned for a message started by that app and still in streaming state; Slack documents `message_not_owned_by_app` and `message_not_in_streaming_state` failures.
- Omitting `thread_ts` creates a top-level stream only in a session channel where the whole channel is one session, such as Slack Code. It is rejected in ordinary project channels.

Task-card and plan blocks are also Block Kit types, so Concierge could theoretically attempt to replace the human root through `chat.update` using Tejas's user token. That would still not be a native stream, would make agent activity appear user-authored, and collides with Slack's `block_mismatch` rule for replacing a normal human Rich Text message with non-Rich-Text blocks. It is the wrong primitive even if a particular mixed-block payload can be made to pass.

The stream is not the completion signal. Slack documents `chat.stopStream` as finalizing the existing message at the same timestamp; it does not document a fresh notification at that boundary. The design therefore keeps one live progress reply, stops it when the provider turn becomes terminal, and posts the final answer as a second, new reply. That second reply is intentional: unlike a message edit, it enters Slack's normal new-message notification path, subject to the user's Slack notification settings.

## Exact provider-to-Slack progress contract

The installed Codex 0.149.1 schema supplies distinct provider signals capable of rendering the separate layers visible in the screenshot; Concierge does not need to infer them from one undifferentiated text stream. The [Codex App Server protocol](https://developers.openai.com/codex/app-server/) emits UI-ready notifications with exact `threadId` and `turnId` ownership:

| Codex signal | Meaning | Slack projection |
| --- | --- | --- |
| `agentMessage` with `phase: commentary` | A provider-authored narrative checkpoint; this aligns with the black prose updates in the screenshot | Append the complete checkpoint once to the existing progress message; prior commentary remains visible |
| `item/started` / `item/completed` for the displayable item allow-list below | Typed foreground activity and its terminal state | Replace the contents/status of the one `current-activity` card; never append an activity history or create another Slack reply |
| `turn/plan/updated` | A whole current-plan snapshot with an optional explanation and steps in `pending`, `inProgress`, or `completed` state | Update one stable plan-progress task such as `Step 4/7 · Independent review` |
| `turn/diff/updated` | The latest aggregate diff for the turn | Persist for the final result; V1 does not put diff churn into live progress |
| `thread/compacted` or a `contextCompaction` item | The provider compacted context | Append one low-emphasis lifecycle marker, as shown in the screenshot |
| approval or user-input server request | Work is blocked on Tejas | Suspend the Agent session and post one new tagged actionable reply |
| `agentMessage` with `phase: final_answer`, followed by terminal `turn/completed` | The durable result | Keep it out of the progress stream; post it as the distinct final Slack reply and extract its TL;DR for the root |

`agentMessage.phase` is nullable. An unclassified agent message must be buffered until completion establishes its role; Concierge must not accidentally stream final-answer tokens into the progress message. `item/reasoning/summaryTextDelta` is a separately available readable reasoning summary, while `item/reasoning/textDelta` is raw reasoning. These must not be conflated with the separate `commentary` phase; the screenshot's black prose aligns with commentary, but the closed-source desktop rendering cannot be source-verified. The first version should expose provider-authored `commentary`, use a plain `Thinking` activity state for reasoning items, and omit both reasoning streams rather than duplicating commentary or exposing private reasoning.

### What accumulates and what is replaced

A Slack task card is a structured part of the one streaming message, not another reply. It has an ID, title, status, and optional detail/output. Re-sending a `task_update` with the same ID is intended to modify that card. V1 creates exactly two stable card IDs in the stream: `current-activity` and `plan-progress`.

| Visible element | Update rule | What remains after the update |
| --- | --- | --- |
| Provider commentary | Append each completed `phase: commentary` message once | All earlier commentary checkpoints remain in the same progress reply |
| Current activity | Replace the `current-activity` title and status in place | Only the current foreground operation is presented as current; no operation log is accumulated |
| Plan progress | Replace the `plan-progress` title and status in place | Only the latest `Step N/M · current step` snapshot is shown |
| Final answer | Post one new reply after stopping the stream | The progress reply stays as progress; the new reply is the completion notification |
| Root TL;DR | Replace the root once after terminal delivery succeeds | The terminal cumulative summary is visible without opening the thread |
| Agent lifecycle | Transition the native session state | No Slack reply or reaction is created |

There is no commentary “boundary” with hidden behavior and there is no “activity epoch.” Commentary does not decide when activity is complete. The provider's typed `item/completed` event does.

The `current-activity` card is selected mechanically:

1. Track displayable main-turn items by their provider item ID and start order.
2. The most recently started unfinished displayable item is current.
3. When that item completes, mark the card `complete` or `error`, then move it to the next-most-recent unfinished displayable item if one exists.
4. When a later item starts, reuse the same `current-activity` card ID with the new title and `in_progress` status.
5. Nested sub-agent operations are not mirrored in V1. A main-turn collaboration item may display `Starting sub-agent`, `Waiting for sub-agent`, or `Reviewing sub-agent result` when the provider emits that typed item.

The title comes only from this allow-list:

- reasoning → `Thinking`
- command execution → `Running <safe executable or recognized action>`
- file change → `Editing <count> files`
- MCP or dynamic tool call → `Using <app/tool name>`
- web search → `Searching the web` with a safe, short query when appropriate
- collaboration → `Starting`, `waiting for`, or `reviewing` a sub-agent
- image work → `Inspecting image` or `Generating image`
- sleep → `Waiting <duration>`

The card excludes full commands and arguments, stdout/stderr, environment variables, absolute paths, patch bodies, tool results, secrets, and raw reasoning. Unknown item types are omitted. This is how “useful provider-backed operations” is defined; it is not a model-generated summary and it is not every event.

`turn/plan/updated` supplies a whole plan snapshot but no stable IDs for individual Codex plan steps in 0.149.1. Concierge therefore computes the first `inProgress` step, otherwise the first `pending` step, and emits one `plan-progress` card such as `Step 4/7 · Independent review`. When every step is complete, that same card becomes `complete`. V1 does not create one Slack task per plan step.

Concierge already receives these App Server notifications in `bot/src/codex-app-server-client.ts`. `bot/src/codex.ts` currently reduces them to `started`, `narration`, `tool_use`, and `done`; it already recognizes commentary versus `final_answer` for terminal selection, but sends all completed agent messages through the same `narration` callback and ignores the richer plan, diff, compaction, and item state needed by this design. The implementation work is to preserve this typed structure and project it durably, not to ask another model what the agent might be doing.

Claude Code should use the same provider-neutral contract but may produce fewer signals. Its stream protocol contains `tool_progress`, `tool_use_summary`, and `stream_event`; unsupported fields degrade to Agent-session lifecycle, any proven commentary, and the distinct final reply. Missing live detail must never break completion delivery.

### Screenshot-equivalent Slack shape

```text
Root while running: exact user request
└─ Progress reply (one app-owned stream)
   ├─ Commentary checkpoint 1 (kept)
   ├─ Commentary checkpoint 2 (kept)
   ├─ Current activity card (replaced): Running independent review…
   └─ Plan-progress card (replaced): Step 4/7 · Independent review

Completion adds a new reply: full provider final_answer
Root after completion: Concierge TL;DR extracted from that final_answer
```

The stream may be updated many times but remains one Slack reply. V1 deliberately does not reproduce the screenshot's generated gray operation roll-ups; that would require another summarization/retention policy and adds no information that the current activity, commentary, and plan do not already cover. Completion remains a separate new-message event.

## Responsibility boundaries

| Responsibility | Owner | Reason |
| --- | --- | --- |
| Report facts about plans, items, tools, approvals, and user-input requests | Provider adapter | Only the provider protocol knows what actually happened |
| Normalize provider facts into turn progress and durable operational-failure projections | Turn lifecycle/coordinator | Keeps Codex and Claude differences out of Slack code and makes recovery possible |
| Choose Slack primitives, coalesce updates, retry/park terminal effects, and insert mentions | Slack projector owned by Concierge | Agents must not call Slack or decide transport behavior |
| Write the cumulative TL;DR content | Provider agent under the existing response contract | It understands the work product and conversation context |
| Extract, persist, and project that TL;DR into the root | Concierge | Root editing is a Slack side effect and must use the correct author identity |
| Declare a future semantic need for a decision or clarification | A future structured provider request | V1 does not infer this from prose; parsing a question mark or prose is unreliable |
| Detect operational failure requiring intervention | Concierge lifecycle | Retry exhaustion, ambiguous delivery, and dead ownership are machine state, not model judgment |

The decisive rule is: the provider emits meaning; Concierge owns attention and presentation.

V1 tags definite operational failures that require Tejas and sets the Agent session to `suspended`. Semantic decision, clarification, and approval pauses are deliberately not claimed as implemented: they need a provider-neutral request/answer contract and resumable ownership semantics. If that feature is added, map native provider requests into that contract rather than asking the agent to manually post a Slack mention or heuristically parsing its prose.

## Turn projection state machine

The turn and the Slack Agent session are related but not the same object. A provider session persists across many turns; each turn owns at most one progress stream and one final reply. The projection mode is chosen and persisted at admission, so a turn never changes from legacy to Agent projection halfway through.

| Input | Required current condition | Durable change | Slack side effect | Result |
| --- | --- | --- | --- | --- |
| Turn admitted | No owner exists for this input | Claim the exact provider session, turn, channel, root, user, and projection mode | Start the one stream | Turn `processing`; Agent session `processing` |
| Commentary completed | Event belongs to the exact live turn | Coalesce the append in the turn-local projector | Append one Markdown chunk | Earlier commentary remains; turn stays `processing` |
| Displayable item started/completed | Event belongs to the exact live turn | Replace the turn-local current-item snapshot | Re-send `current-activity` with the same card ID | One visible current activity card |
| Plan snapshot updated | Snapshot belongs to the exact live turn | Replace the turn-local latest plan snapshot | Re-send `plan-progress` with the same card ID | One visible latest plan card |
| Definite operational failure requires intervention | Exact failed turn and requester are known | Persist the tagged action-required projection | Set session `suspended`; post one tagged actionable reply | Turn terminal or parked; session visibly needs attention |
| Provider final and terminal event | Exact turn owns the terminal result and no Stop intent won | Atomically persist final answer and delivery ownership | Stop stream, durably project `active`, post the new final reply, then update root TL;DR | Turn terminal; provider session remains reusable |
| Native Stop event | Channel/thread maps to exactly one live owned turn | Persist stop request before cancellation | Interrupt provider, finalize the exact stream, set session `active` | Turn stopped; provider session remains reusable |
| Ambiguous Slack or provider boundary | Prior effect cannot be proven absent or present | Park the exact projection/effect; never replay blindly | Post a tagged recovery notice only when human action is necessary | No duplicate final, root edit, or cancellation |

Commentary, item, and plan updates are lossy turn-local projections within `processing`; they are not new workflow states or recovery data. Every append/update targets the persisted stream timestamp, passes one credential-redaction gate, and uses a short coalescing window that keeps only the latest task snapshots. The provider result remains the durable work product.

## Recommended thread protocol

### 1. Admission

- Persist the user input and turn ownership first.
- Start one app-authored stream under the human root. Slack documents that `chat.startStream` creates the thread-based Agent session when needed and sets it to `processing`; Concierge persists the returned stream timestamp before later projections.
- The stream is the visible working indicator. Do not add a second Assistant-thread status or reaction alongside it.
- Do not add an hourglass reaction and do not create a status reply.
- Leave the human-authored root unchanged. The router already gives routed roots concise wording; a manually written root needs no second model-generated request summary.

### 2. Work

- Append each proven `commentary` agent message once. Do not edit or delete earlier checkpoints during the turn.
- Maintain the one `current-activity` card using the mechanical selection and allow-list above. Do not retain completed operations as separate cards.
- Maintain one stable plan-progress task from the latest whole `turn/plan/updated` snapshot.
- Do not stream reasoning text, reasoning-summary deltas, shell output, full commands, tool arguments/results, diffs, or final-answer tokens.
- Steering changes the provider turn and the current plan/task projection; it does not post an acknowledgement reply.
- An automatic provider retry keeps this same stream open and resumes it on the next exact turn claim. It does not append a retry ceremony or create another stream.

### 3. Operational failure requiring human action

- Persist one durable action-required projection owned by the exact failed turn.
- Set the Agent session to `suspended`.
- Stop the existing stream, then post one recovery-safe reply containing the requesting user's Slack mention and the smallest sufficient recovery context. This extra reply is intentional because it is actionable; an appended mention in an already-delivered stream is not yet proven to create a notification.
- Do not mention for an automatically retried failure or ordinary success.
- V1 does not pause a live provider turn for semantic decisions, clarifications, or approvals. That requires a separate structured provider request/answer contract; it must not be simulated by parsing agent prose.

### 4. Completion

- Atomically persist the provider's final answer and claim delivery only if a native Stop has not already won. Extract its existing cumulative `TL;DR:`; do not generate another summary or truncate the original request into a hybrid root.
- Stop the progress stream with its commentary, latest plan, and latest activity state intact. A normal `chat.stopStream` ends the processing lifecycle. After a native Stop click, Slack has already stopped the listed streams but has not changed the session status, so Concierge explicitly calls `agents.sessions.setStatus(active)`. Use `closed` only when Concierge intentionally ends the conversation permanently.
- Post the full provider `final_answer` as a new durable thread reply. This new message is the completion signal and is eligible for Slack's ordinary thread notification behavior; the stopped progress stream is not reused as the answer.
- After final-reply delivery is confirmed, replace the root with the validated `Concierge TL;DR`. A root-edit failure must not delay, duplicate, or roll back the final reply.
- Leave the final reply unmentioned when no action is required.

### 5. Stop

- Subscribe to `agent_session_stopped` before presenting an interactive native Stop button.
- Map the event's `channel`, `thread_ts`, and `streaming_message_ts[]` to the exact live provider turn. The stopped-stream array must contain the durable stream timestamp owned by that turn; an old event cannot cancel a successor.
- Interrupt that turn, clean up its owned resources, stop/finalize the exact stream if Slack has not already done so, transition the Slack session to `active`, and keep the persistent provider session available for a later turn.
- Slack does not transition session status automatically after the click; Concierge must do so.

## Root editing and Slack's length limits

The 4,000-character result applies to the ordinary `text` argument of `chat.update`. A live probe tried to write the current root's identical 4,797 characters with the matched Tejas user token and received `msg_too_long`; Slack content did not change.

Slack's newer `markdown_text` argument accepts standard Markdown and has a documented 12,000-character limit. It is mutually exclusive with `text` and `blocks`. A Markdown block also has a cumulative 12,000-character payload limit. Rich Text blocks are structured Block Kit objects—useful for explicit link, mention, and formatting elements—but Slack does not document them as an unlimited-message escape hatch. They also add read/merge complexity when editing a human-authored message.

Therefore Rich Text can solve formatting, and `markdown_text` can cover the specific 4,797-character root, but neither lets an app stream into an existing human-authored root. There is also no need to solve the root limit by truncating or creating a second request summary. The root transition is:

- While work runs: preserve the original human-authored root exactly.
- At successful terminal delivery: replace the entire root with the provider's already-produced cumulative `TL;DR:`, labeled `Concierge TL;DR`.
- Durable Concierge turn state: the exact original user input.
- App-authored stream: commentary checkpoints, current activity, and plan progress.
- New terminal reply: the full final work product.

The provider already owns cumulative summary generation through the existing response contract; Concierge only validates, extracts, persists, and projects it. Projection should use `markdown_text` when needed, but a TL;DR that is absent, invalid, or over Slack's documented 12,000-character limit must leave the root unchanged rather than being invented or silently clipped. A rejected root edit also leaves the root unchanged; the separate terminal reply remains the durable visible result and the projection failure is persisted. If later testing shows that Tejas misses the original Slack-visible prose after a successful replacement, the reversible alternative is to leave roots untouched and accept that the TL;DR lives in the terminal reply. Conditional raw preservation below the summary is rejected as the default because it changes behavior at Slack's 12,000-character boundary.

Reference: [`chat.update`](https://docs.slack.dev/reference/methods/chat.update/) and [Markdown blocks](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/).

## Direct existing-app rollout

This is a regular Concierge feature. The existing app is declared as an Agent and adopts Slack's session and streaming APIs directly. There is no second app, no user or channel migration, no bulk conversion of old threads, and no separate pilot configuration.

The repository manifest now:

- declares `features.agent_view.agent_description` and a writable App Home Messages tab;
- adds the `assistant:write` bot scope;
- subscribes to `agent_session_stopped` so Slack's native Stop control reaches Concierge; and
- retains the existing message subscriptions and scopes used by normal routing.

The runtime implementation now:

1. Records `projection_mode` when each turn is admitted. A turn keeps that mode for its entire lifecycle, so a turn already running during deployment is never converted underneath its provider.
2. Starts one `timeline` stream for each newly admitted user turn, keyed by the durable turn, channel, and thread. Concierge joins a managed public channel before the first stream there.
3. Accumulates provider commentary, replaces only the stable `current-activity` and `plan-progress` cards, and applies one tested credential-redaction gate after omitting narration/final-answer tokens, raw reasoning, commands, arguments, output, and full paths.
4. Keeps the Agent session in `processing` during long work through a durable latest-status projection. An in-flight heartbeat finishes before terminal `active` or `suspended`, so it cannot regress the session after completion.
5. Routes `agent_session_stopped` through the exact Slack channel/thread and currently owned turn to the provider's cancellation primitive. A stale or mismatched event cannot cancel another turn.
6. Atomically chooses Stop or delivery, persists the provider result before the terminal Slack boundary, confirms the progress stream stopped, then posts the result as a separate durable final reply. Recovery preserves this order.
7. After final delivery is confirmed, durably attempts to replace the human-authored root through the existing user identity with `Concierge TL;DR: <provider cumulative summary>`. Failure parks only that projection and never hides or demotes the final answer.
8. Posts one tagged durable reply only when a terminal failure needs Tejas's action. Automatic retry remains quiet and reuses the exact existing stream; ambiguous stream creation is parked rather than replayed.

Older persisted turns default to the previous projection and finish with its hourglass/status behavior. That is an internal per-turn compatibility invariant, not a staged product mode. New ordinary user turns use Agent sessions immediately after the existing app is reinstalled and the code is deployed. Deployment-verification turns retain their existing projection because they are a separate ingress contract.

### Activation and smoke check

The ordinary activation sequence is:

1. Commit and push the code, manifest, docs, and focused state-transition tests.
2. Upload `slack-app-manifest.json` to the existing Concierge app (`A0BNG0WHUNQ`) and reinstall it. Copy replacement tokens only if Slack issues them, then verify the installed scopes with `auth.test`.
3. Deploy through the normal Concierge deployment path.
4. In the existing app, run one harmless thread and then two simultaneous threads. Confirm per-thread session isolation, accumulated commentary, replace-in-place activity and plan cards, exact Stop behavior, a separate final notification, and terminal root TL;DR replacement.
5. Let one long-running fixture cross a lifecycle-heartbeat boundary and verify it remains `processing` without adding a message.

These are live smoke checks for a newly built feature, not prerequisites for building it in a clone. If Slack's live contract differs from its documentation, correct the smallest affected transport seam in the same app.

### Rollback

Revert new-turn admission to the previous projection and use the normal deployment path. Turns already owned by the Agent projection finish or park through their recorded lifecycle; delivered Slack history is not rewritten. The Agent declaration may remain installed because it is harmless when Concierge is not opening Agent streams.

## Design completeness and next action

The V1 behavior is decision-complete:

- one native session lifecycle, no lifecycle emoji and no Assistant status;
- one progress reply per provider turn;
- commentary accumulates in that reply;
- one current-activity card and one plan-progress card are replaced in place;
- no raw reasoning, command output, secret-bearing detail, generated activity roll-up, or final-answer token enters progress;
- one new final reply marks completion;
- the terminal root becomes the provider's validated cumulative TL;DR only after final delivery;
- one new tagged reply is reserved for action actually required from Tejas;
- Activity and the Agent session list are navigation surfaces; message bumps are not a scheduling mechanism.

Requirement coverage is explicit:

| Original need | V1 answer |
| --- | --- |
| Navigate many ongoing threads | Native per-thread Agent sessions, pin/rename/archive, Activity for new attention, Save/Later for personal deferral |
| See that an agent is working without message spam | Agent session `processing`; no emoji, loading-status reply, or steering acknowledgement |
| See credible live work on a long turn | One progress reply with accumulated provider commentary, one replace-in-place current activity card, and one replace-in-place plan card |
| Avoid leaking noise or private detail | Typed allow-list only; omit raw reasoning, output, full commands, arguments, diffs, and secrets |
| Know when work actually finished | A separate new final reply; stopping/editing the progress message is not the completion signal |
| Know when an operational failure needs Tejas | Session `suspended` plus one new tagged actionable reply; semantic decision/approval pauses remain a separately scoped provider-contract feature |
| Scan results from the channel | Terminal root replacement with the provider's validated cumulative TL;DR after the final reply is confirmed |
| Preserve the original request | Exact input remains in durable Concierge turn state and verbatim research context remains in this document; the Slack root is unchanged until terminal success |
| Keep Slack List readable | One high-level to-do row points here; requirements, decisions, experiments, and raw discussion stay in this file |
| Work across Codex and Claude | One provider-neutral progress contract; unsupported live detail degrades without blocking the final reply |
| Move to Slack's current Agent protocol safely | Direct existing-app feature rollout, per-turn lifecycle ownership, no mid-turn conversion, and a reversible projection boundary |

The implementation action is complete in repository source. The remaining external action is the normal existing-app manifest reinstall, deployment, and live smoke check above; there is no clone or migration phase.

The provider event model remains independent of Slack presentation, so a Slack transport correction does not require re-instrumenting Codex or Claude.

## Raw source context

The following text is preserved verbatim so the original problem and line of thought can be reconstructed after the Slack List row is shortened.

### Initial capture and continuation

> *add hourglass emoji everytime agent is processing in the thread, edit the top level message to give session details? basically need to brainstorm and design handling multiple ongoing threads and able to navigate open threads more easily than scrolling around the channel to find open sessions to engage. especailly cos I keep opening new threads and some old threads persist for long and moves back into the scroll history with inbetween threads. Additional context to preserve: I just started a new to-do here for brainstorming and designing handling multiple ongoing threads and being able to navigate those threads. Let’s expand that. I had an idea. One thing we need to do is really understand the threads functionality of Slack—not the message threads themselves, but if you go to the sidebar there is a Threads section that gives you all the ongoing threads, right? I think that should be the control surface area for all of the ongoing things I want to respond to. But sometimes it’s kind of confusing how to use that because some open threads show up there, some older threads show up there, and the ordering sometimes doesn’t make sense. So we need to really understand how Slack is handling that Threads functionality or showing ongoing threads in the sidebar and then reverse engineer our workflow around it. If Concierge bumps a thread, that creates an unnecessary item at the top of the stack that is no longer actionable by me and I need to scroll past it, so how do we avoid that? We need to understand exactly how that functionality works so we can design our workflow around it. Also look into how we can avoid showing some of these threads there; for example, the Slack Inbox agent and its thread are not something I really want to see because Slack Inbox is just doing routing. Those routing messages also pollute the Threads section. Is there a way we can exclude some channels so they don’t show up in Threads? How do we deal with that? Those are the kinds of questions we need to answer and understand. Keep the raw context in this task so it is possible to return later and reconstruct the original problem and line of thought, rather than replacing it with a compressed summary. Related status-management idea to preserve: By the way I guess like a related idea i had for managing statuses right so i see you know right now because we add a new message to show what the status was that kind of creates an unnecessary notification but what if we combine the fact that to summarize the session information and we can add this status information in the top level thread itself so that would just editing the message that I sent because sometimes if its coming from the slack inbox the agent will route to the right channel and post the message as if I sent it So that message can be edited to give those status at the top-level summary of this session or the summary of the idea on the status of what’s going on In that way we don’t create another unnecessary message for the status itself. And we only add notifications when the agent has actually completely done so that could be one idea but obviously i’m not fully sure about what happens when we remove my whole message If you edit only a summary of my request Will that be sufficient? Where would my whole request go? The agent will have my whole request because that would be passed to it but I’m wondering if we can remove it from the slack. It could be something we experiment with and see if I do miss my own long messages then we can bring it back but i don’t think we’ll need that as much So the top level messages could be the summary and statuses.*

> And maybe for status reporting like for all intents and purposes we should stop using messages when you can just use emojis and represent information from emojis I guess only for status it could be useful for updating the original message editing the original and just look at the top level TLDR in the original message itself without having to go inside the thread. Because we already have system of keeping that TLDR updated, I think that could help us basically have proper status in there. For example things like steering right now when you come out and steer it into a different direction we receive another message that it’s steering. That could actually just be another emoji right? It doesn’t have to be another message because what’s happening is like every single message which is not really a message I have to pay attention on spams the thread section to navigate and try out what requires my attention properly so that is the design that we have to do here like how do i how do we design this system so that we can leverage this slacks threat functionality for me to pay attention where it is required to attention and not for random status things

### Follow-up on native assistant status and attention

> Tell me more about Slack Assistant Threads that set status How is it different from adding an emoji or something? What is a loading text? And what do you mean by creates no reply and clears when concierge replies? Is this automatically for put out or click because I feel like that’s what we’re doing today. We add an emoji, we update this address and then clear the emoji after the agent responds. So if they already provide something like that we should look into that. so so It looks like there’s a whole agent messaging experience thing they have launched here we need to look into that so we can like adopt and use the right protocols and way to do things here instead of contorting or using existing users human workflow here. For example they have something suggested prompts. And i don’t know if that means we can suggest a prompt to respond or something like that on what’s going on there, it could be useful for us to understand all of the assistant related functionalities I’m not sure what I want to say but yeah looks like suggested prompts is not what i was thinking so i think we can skip that but it will be useful for us to have a comprehensive understanding how slack is thinking about these agents like and how we can kind of like adopt them I think even my own user profile is already implemented here I don’t understand what you mean by “concierge bot cannot edit routes you authored” yes the bot itself cannot edit The router actually posts messages as me. We cannot always rely that the router is only one posting messages because I am going to be starting new threads in channels as well. But if the router can post a message as me, I am assuming we can also edit messages that are sent by me. So And I think for failures needing me, you probably can also start tagging me. I think tagging also could be a useful way for me to get attention to the right things here because sometimes an update and like sometimes just a response from what was done if they feature is already implemented or well-implemented I don’t even have to take a look at this right. So unless I’m tagged I think for somethings that I can safely ignore so tagging could be useful when I do have to pay attention. And that’s not included in our model at all so and I see in the recommended projection model you are talking about native thread status plus an emoji and triggering message and then refreshing native status before its 2 minute expiry Let’s understand this, right? What is the native threat status? How does it display? If it is going to display something then why do we need another emoji? Let’s simplify the design. Understand that simplicity is ultimate sophistication Do not create multiple unnecessary information This whole design is about how do we convey information enough information at the right time how would we channel attention to the right things here? If there’s a native threat status what is that doing? What is our functionality here? How was it different from an emoji? Let us understand all of this before suggesting things here. And I think we should still look into updating the user authored message with the TLDR instead of the status message because then i don’t have to dive in each thread to kind of see what the status was. If i’m in the channel I can look through all of the messages because they work done without having to go into thread like now start fishing over For routed slant inbox it already does adding a concise detail on all those things. If its not clear we can update the instruction but I think it already already. So the question is really looking up for messages that I do send yeah, I think we can... It’s okay. We don’t need to look into exclude this channel from thread setting. That’s fine all of the channels for now because at this point I probably would still need routing related messages because i am basically using the router related messages and threads to fine tune their routing agent itself so let’s keep that up for now but I’m also liking the activity view actually the activity views actually look lot more better here because it gives us like a side panel looking I can navigate between open different open threads here unlike threads view where you know i have to like scroll through a bunch of things so I’m actually liking the activities or maybe activity is something we can configure you know keep upgrading going forward I guess if you dont know what native status visibility and how it acts and feels like then I agree lets do a small implementation to understand how it works I am surprised we have to experiment reactions for thread ordering is not documented? For threads seems like a very important feature Do they not know if reaction or emoji actually changes ordering? And also what about setting status yeah, if you don’t know, it’s fine, make an experiment for return later, I can just use the slack functionality for as much as possible we should use slack right so slack already have a save message so thats what i’ve been using I can like just save that message and come back to it later if there’s other more design questions please post once and for all do not keep posting one design question at a time let’s figure this out to be a comprehensive solution if I know exactly what all the questions are

### Follow-up on to-do ownership, dynamic progress, streaming, and limits

> I think we need to update the mechanism for todos here. The todo item is like for high level todo action items any work that has been done there should be done in a different file for one particular todo item otherwise we’re gonna just keep polluting the slacklist making it unreadable to be a pointer and linked to action items that we want to proceed anything beyond that design discussions requirement discussion should all be in different file and presumably probably in a docs folder and the todo item could link to that docs folder file because docs where we are gonna put designs and things like that So, we are updating the 2D item here. This seems like a broken process that we might have to update but yeah looks like native assistant status is like what we should be using here to reflect some of relevant work the agent is doing. So I don’t know if that functionality is like what the loading text is? And if the loading texts can be dynamically created here? Because there’s a two minute timeout I’m assuming we’re gonna have to keep refreshing this status every two minutes and that could be a good enough opportunity for us to grab the latest. What the agent is doing to update the loading text here or whatever the status it is but overall i think this is exactly what we should be using any of the agent in progress things. Whether still an external emoji is required, it’s something that we can think about but I think it’s safe to say we can remove that functionality like rely on native status here and only add that once if it’s needed later yeah I guess you come to the same conclusion here so I agree let’s move to native status I mean yes, so I agree we should not migrate production to merely obtain a loading indicator but if slack is actively transitioning into to using agent sessions and agent message experience. It’s an active development. If that’s the path forward then it makes total sense for us to do migration because we want to be adapted into the latest protocol instead of relying on an older API that could not be updated. It might have the same experience that we need right? For example the stop button is actually interesting. The stop button could be useful. I might need that but also really like custom loading phrases feature from the assistant threads but only if it’s custom loading phrase is dynamic. If it’s not dynamic there is no What are the points in having custom loading phrases? You’re not going to entertain me with having a custom loading phrase. I’m working with an emoji here, that’s fine. Working is fine. Static is fine The only useful thing I would need is loading phrases which are actually relevant to what the agent is doing dynamically generated dynamically updated just how the codec CLI or even the cloudcode CLI does it if you know those features so we can see what those are and if thats what do you mean by that and how does that work you you I mean, I would like to learn more about the default plan or task streaming I think streaming is useful sometimes right? Sometimes I am waiting on the app. The whole reason...I had to go to the in codex app and make a connection through the codexapp sometimes i have no visibility on what the agent is doing here on slack the agent has been working for 2 hours what it’s doing so my requirement for loading text requirement is not really static loading text but it’s actually like plan on start streaming. But I would like to understand if this streaming is basically what the agent is for Then we have to look into it And understand what is an actual reply and continuously updating that What does that mean Because that could still be useful Maybe there could be an opt-in Maybe I can opt in for that And get those updates For me Some things But also we need to understand what’s that task streaming And plan streaming What amount of information is being loaded. If it is just that oh you can stream a response from the agent right? The entire like no response we’re getting from the age and then instead of having one message up here you see the text streaming. Then that’s not really useful. What really is useful as understanding what actions the agent is taking at that moment in time. Right and I think it might be useful for us to understand this feature specifically especially in terms of like the codex app server and if it actually provides this functionality or not because I open the codec app now i can see exactly what the agents are doing right it says its like thinking and then it says okay its reading handler.ts. It also keeps giving slight minor updates. Of course I can expand that thinking to see all the different operations did. If this is something supported by the app server then we should absolutely rely on that instead of us kind of like we should not be looking at the agent response or creating a summary or whatever so I think it’s useful for us to do a dive deep research here thinking functionality from these agents and how they work How do these agents do How is it differentiated from normal agent responses and how do we differentiate today from normal agents responses because today we only send a message after the whole turn is finished to to what the agent is doing. Maybe I’d still go to the codex app. And that’s the destination. So we keep Slack completely as like a much more slim, much less noisy version of it because I think creating new message, a new response for every single response is still bad but if Slack is moving towards providing this kind of status updates without creating messages then that’s something we have to really understand and obviously understanding how do we get the same things from Cloud Code because Cloud Code is not exposing any sort of app server and I think its fine we’re mostly not using Cloud Code for most of this work so even if its not supported its fine but we know we need to make sure that like that the app section interfaces doesn’t fail just because this streaming is not supported for some agents. And yeah I agree i think you know even if you do support if you can make this a seamless thing then opting in as an option that we have we can provide or we can...or if it’s too complicated, if that’s not officially supported, if you have to engineer all of this thing from scratch, then we can have clear distinction between codex app and Slack app and codex where I would go to look at detailed step-by-step things I am skeptical of that because if the codex app is running using the same app server I am going to assume the app server is publishing these little details about what the agent is doing that we can actually use here I don’t think we should worry about manifest migration I don’t think that should be a concern at all. The concern is having the best experience that we can create. We should reach to the platonic ideal of like “what I want” here. And if that requires installing a new app or a new bot/agent let’s do it. Like I don’ t think this should be driving decisions at all here. So, I see here in the recommended protocol you were talking about for sharing accept it change the status to is applying your latest direction so then i’m assuming we can change the native assistant status here dynamically? Is that what’s happening here? And for decision clarification approval required we need to make this distinction between who is going to update the route to LDR versus who’s gonna post one reply mentioning my tag. Is this an agent or concierge app itself? Because how will the concierger app know if there is a decision required? And if it’s going to be an agent then it’s and action item will be for the agent. We might have another update our instructions for the agents to do that. We need to understand the responsibility split here so so I mean i think it’s actually i’m so curious about the 4000 character limit here because I see like the router agent is actually creating a huge text huge messages like i mean i haven’t counted them maybe it is still limiting itself to the 4000 limit here but that is actually very interesting restriction and I do not know what you mean by the slack rich text blocks here or the newer markdown text and is that not subject to the same 4000 character limit? So you you

### Follow-up on per-thread status, root TL;DR, and default task streaming

> Okay so I think if we can combine these things you kind of like for the much more optimal experience. From what I’m reading, is there any reason for using the assistant threads.setStatus? If it’s going to be just like a loading message which is a static list then it’s not really something we can use. You said that we can make it dynamic by replacing this status whenever a meaningful provider event arrives but you do realize that concierge and channels will have 100 different threads happening maybe not 100 but at least 5 different ongoing agent requests at any given time How would you do dynamic replacement for this status? To apply to the right agent at the right thread. Because is this like you know, the loading messages is just like a static message per thread or is it static messages that we said like once and for all for the entire application? Do we know because then that’s what really determine if you can use this or not. As a dynamic status, not across one thread but across multiple threads And if you cannot do that then agent session status is probably where they go forward because if you don’t have dynamic messages at least we can do this But at the same time if you can use slack task plans streaming thing. But instead of creating a reply can we basically use that in our TL;DR? In the TL;dr that we’re going to edit in the root so why can’t we combine that? Can you combine a route TLDR with the slack task/planning streaming or is that completely different thing? Because like, you know, the route TL DR will be still something that I post and not the agent posts, right? So is the slack planning and streaming require like an awesome sort of on app or a bot to be doing that? And, you there could be value here because it actually does provide information on what the agent like some visibility to what they’re doing and like that’s actually useful a lot of times. And I would like say for now let’s make that default. One thing we need is quiet mode and live mode again adding unnecessary things here we can just have a new message it is ok one new message is not going to pollute as much immediately seen you know it can be like it will only in the thread I think but if we can make this happen at the root level then I think that is what we should be using so then we avoid creating new messages all together. And we should understand how does this like you know this whole agent sessions I don’t understand what your plan here in terms in terms of overcoming the 4000 limit here and how do you plan on updating the root here and are you saying that basically update the root with summary of the request and then the tldr and if you’re going to just truncate the request so that we can add the tldr and if we can have a summary who’s gonna create the summary here? Have you thought of any of these things in this design or should we... We think more on this

### Follow-up on exact progress content and a distinct final notification

> Wait wait wait this is not clear enough for me like I mean I think like I agree with that yeah let’s do away with assistant set status here. I think yeah lets just keep agent session as owning this lifecycle and task on planning streaming to for live progress so I think that is good and yeah the protocol for let’s preserve the exact route while working that’s fine for start one app author task reply plan reply immediately yes this is the default that’s correct update the same reply with useful provider backed operations right? This is... You cannot just like blindly say that How do you define useful provider back operations? What gets in here? What doesn’t get in here. These are things that have to be understood here. You cannot just blindly say that. We need to understand what can be updated here And turning that into a final response is not something that i like because then i won’t be notified when the final response was ready The whole reason the final responses could be its own thing is like then i get a notification or like you know there’s a message that is a final message If you just turn the same reply and change that then like you will remove that whole life cycle about when the task is done But yeah, the other things make sense Tagging only when action is required and successful completion we can just update the tlduar in the root And we also need to think about what the provider is writing. It’s yeah it is writing cumulative TIDs and things like that And if that something you’re planning to use as part of the streaming replies or are you planning to use some other statuses here and if so what is it so that’s something we need to understand And there is two different things that we control here. For example when I look at the codex app, there’s an actively running status. Sometimes it’s thinking sometimes actually showing me oh its like i’m running this command right? There’s an active running thing but also a summary coming in here as the agent processing it. So there’s two different things and we should probably have support for those two things here. We can show the active agent work as well as the summaries that keeps coming in. In between updates, the agent also keeps doing in updates. I’ll give you an example in the screen shot you can see so you have a concrete understanding how this is shown in the codex app. You may also have to understand like how the app server works and what kind of events it emits here. So we can use similar things with an understanding of how the apps server work functioning

Screenshot observation: the Codex app interleaves provider-authored narrative checkpoints with gray grouped activity summaries, a current `Running …` operation, an explicit context-compaction marker, and a bottom `Step 4 / 7` plan indicator with aggregate file-change counts. The screenshot remains attached to the originating Slack message.

### Follow-up on design completeness, migration, and unclear progress language

> Okay Do we have everything here? To implement is like all the requirements and things captured. Have you mapped out into how do we start using the agent sessions in what kind of migration I thought this had talked about something about a migration now you’re not even talking about anything What’s going on here How do i tell you anything if you’re not giving any action item? There is nothing in here that tells me that design is final Design has these many open questions that we need to address What is next step? What are we doing here? And your whole description of your own language is like so uptruse here. Okay? So you say narrative checkpoints they come from whatever message And you are saying concerts preserves this text rather than generating another ceremony. What does preserving the text even mean here? Do we keep accumulating these narrative check points or do we edit and update the previous one And then you talk about active execution So is it all of the Are we going to show all of events here? And what do you mean by one task card? How does this task card have space for these different events? And then look at the sentence between two commentary checkpoints operations form one activity epoch. What is the two commentary checkpoint ? What is one activity Epoch? When is this Epoche changed? How do you know item is completed to collapse it? You say like this uses commentary boundaries. I just don’t understand what the boundary is. And if you have a good solid boundary you

### Follow-up rejecting a cloned-app migration

> I’m not sure how to use this so so I don’t know if we have to do the cloning of the current app. Why do we need cloning? This is an app that I’m the only single user so i don’t understand why we have to do this elaborate process here. We can just build it out and if things are not working you can improve it right this does not make any sense like i think migration there probably should not be any migration we should just build this as a regular feature you you
