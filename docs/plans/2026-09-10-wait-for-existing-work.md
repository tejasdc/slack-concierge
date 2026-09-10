# Wait for existing work

Status: proposed design, not implemented. Updated 2026-09-10. Placement of natural-language interpretation remains an open design choice. Tejas's suggestion that the inbox router might convey waiting intent was a question, not approval of that architecture.

The established experience is: a request appears immediately in its destination channel, its root carries ⏳ while waiting, and work starts automatically in that same thread. Waiting is opt-in. There is no automatic waiting receipt, progress reply, or “starting now” announcement. The behavior must be available across every Concierge-managed product channel.

## Three different responsibilities

“Concierge” names both a platform and a project channel. Distinguish these responsibilities:

| Component | Responsibility |
| --- | --- |
| Intent interpreter | Understand human language: which project, new or resumed work, whether to defer, and what scope the user named. Where this interpreter runs is still open. |
| Concierge service | Always-running Bun/TypeScript bot code shared by managed channels. It persists input, resolves exact identities, applies admission rules, receives provider lifecycle events, and launches eligible work. |
| Destination task agent | Codex or Claude executing the product request with that project's context. It is started only after admission permits it. |

Ordinary code can enforce a wait without understanding English. It checks whether identified executions have settled. The task agent does not need to exist while the request waits. Some interpreter must understand free-form waiting language; a command, menu selection, or structured tool argument already expresses that meaning and requires only deterministic validation.

The existing queue already enforces one running/delivering turn per provider session. Distinct Slack roots can share that conversation in shared-session channel mode. Independent sessions can run concurrently, and an ordinary reply in an active visible thread normally steers that turn. Waiting adds prerequisite checks across sessions; it does not replace these rules.

These existing facts were inspected at source commit `a603001`: [queue admission and selection](https://github.com/tejasdc/slack-concierge/blob/a603001/bot/src/state.ts#L4165), [live-thread steering](https://github.com/tejasdc/slack-concierge/blob/a603001/bot/src/index.ts#L2346), [session routing](https://github.com/tejasdc/slack-concierge/blob/a603001/bot/src/routing.ts#L16), and [event-driven queue coordination](https://github.com/tejasdc/slack-concierge/blob/a603001/bot/src/session-turn-queue.ts#L16). Current contracts are in [turn lifecycle](../architecture/TURN-LIFECYCLE.md) and [Slack input](../architecture/SLACK-INPUT.md).

## Where should interpretation happen?

There are two independent decisions: how the user expresses waiting, and how the resulting machine instruction reaches admission. A command parser decoding an explicit flag is not a second AI judging the user's intent.

| Interpretation choice | Experience and cost |
| --- | --- |
| Inbox router interprets routed requests; direct channel requests use an explicit control | The already-invoked router can extract destination and waiting intent together. No extra model call is needed for enforcement. Direct-channel free-form waiting is not covered unless another interpreter is added. |
| Shared control interpreter before task admission | The same natural-language contract can apply to inbox and direct channel inputs. For inbox input it should combine routing and wait interpretation, not run two competing classifiers. Direct channel messages require interpretation before ordinary execution/steering; this adds latency, model use, and a classification failure boundary. |
| Explicit command/control at every entry point | Most predictable and least machinery. The user must express the scheduling choice explicitly. If the inbox router translates natural language into that control, this becomes the first choice above. |
| Destination task agent reads the request and decides to wait | The task agent has already started before waiting is established. This consumes task execution and cannot meet the promise that the destination task is held before it begins. Exclude this as the scheduling mechanism. |

The first two choices can both satisfy the inbox/voice experience. The product distinction is direct channel input: should “after those agents finish…” work there as ordinary natural language, or is a deliberate command/control sufficient?

A shared interpreter would emit a small typed decision such as `ordinary`, `defer(channel-current)`, `defer(selected-roots)`, or `clarify`. It must have no product tools or product-work side effects. An uncertain decision stays pending for clarification; it does not quietly degrade to immediate execution. It adds a real model invocation even though it never starts the destination task agent. There is no justified classifier cache, speculative fallback model, or new independent service.

Do not equate mentions of “wait,” quoted examples, feature descriptions, or steps inside one task with a scheduling instruction. Preserve the original text and supplied audio transcript. Historical resume references retain the sanctioned router-search contract, exact root identities, and clarification when retrieval cannot resolve the reference.

## The machine instruction

Regardless of interpretation placement, admission receives a typed control separate from task content. Conceptually:

```json
{
  "destination": {"channel_id": "C_PRODUCT", "root_ts": null},
  "task": "Audit the testing mechanism.",
  "start_condition": {"kind": "after_current", "scope": "destination_channel"},
  "source": {"channel_id": "D_INBOX", "message_ts": "1789052454.304509"}
}
```

IDs here are illustrative. A resolved existing root replaces `null` for a resume. Selected prerequisites use exact channel/root pairs instead of a vague topic string. Attachments remain attached to the same request. An idempotency identity must distinguish explicitly split routing actions from the same source message while keeping retries of each action stable.

The interpreter chooses the scope. The service selects actual earlier unfinished turn IDs atomically from its ledger. The interpreter need not inspect process lists or decide which agents have finished. The service validates the channel, source authority, root ownership, and supported condition; this is identity validation, not another semantic opinion.

The receiving handler persists the request and its condition before any path may steer or start a provider. Both immediate admission and later queue promotion apply the same rule. A malformed explicit control fails before execution.

## Delivering that instruction without a race

The exact transport is a design decision, not settled merely by writing “metadata” in a diagram. The invariant is:

> No waiting request can become an ordinary executable Slack input while its waiting instruction is still in transit.

“Post the message, then attach the wait” violates this: Slack can deliver the message event before the helper's next operation. The root's text, timestamp, and later-added ⏳ are not a dependable instruction channel. The emoji is output only.

Three concrete transport choices deserve different treatment:

| Transport | What it establishes |
| --- | --- |
| Deterministic envelope in the same Slack input | A helper could accept `--after-current` and encode an exact `!after` command, including in a file-backed message's initial comment. The central handler decodes the command before steering/dispatch. It makes no language judgment. This is the smallest candidate compatible with the two existing posting paths, but exposes command syntax in the message. |
| Native Slack message metadata | Keeps visible task text clean. Slack documents structured metadata for `chat.postMessage`, but that alone does not establish support for the current user-token and file-upload paths. The guide also permits invalid metadata to be warned about and ignored; missing wait data must never cause immediate execution. This requires exact sandbox proof before selecting it as the transport. |
| Explicit local admission handoff | The existing helper can register a structured request in Concierge's SQLite state before posting. This still requires exact correlation to the arriving Slack message before ordinary dispatch. File IDs can be reserved before sharing; inline text needs an equally proven identity channel. Matching by text, nearest timestamp, or channel recency is unacceptable. This costs a durable admission record and binding/recovery logic, justified only if clean visible text cannot be achieved safely with the native contract. |

Current posting uses `chat.postMessage` for inline text and `files.completeUploadExternal` for voice/files and automatically file-backed long requests ([source](https://github.com/tejasdc/slack-concierge/blob/a603001/bot/scripts/router-post.ts#L350)). The upload method documents `initial_comment` and `blocks`, but no `metadata` argument. The SDK's generic message event marks `client_msg_id` optional, so it is not evidence of a universal identity channel.

Primary references: [message metadata](https://docs.slack.dev/messaging/message-metadata/), [text posting](https://docs.slack.dev/reference/methods/chat.postMessage/), [upload completion](https://docs.slack.dev/reference/methods/files.completeUploadExternal/), and [generic message event fields](https://docs.slack.dev/tools/node-slack-sdk/reference/web-api/interfaces/GenericMessageEvent/).

Do not hide this gap behind two independent events, a delayed interpretation pass, or a keyword fallback. Selecting a clean-text transport requires a bounded sandbox probe of user-authored inline, voice/file, and long-request posts, including event-before-helper-response ordering and missing/invalid control. The design does not promise that native metadata already works end to end.

## The waiting mechanism

Once the input and exact destination root are bound, the runtime mechanism is the same for every transport and interpreter.

1. In one admission transaction, persist the input, session/root binding, explicit start condition, queued turn, and fixed prerequisite turn IDs.
2. Commit before projecting ⏳. The request holds no live provider owner, execution lock, sandbox lane, or active-turn slot.
3. When a prerequisite finishes, its existing lifecycle owner commits the outcome and wakes the existing queue coordinator.
4. The coordinator checks that all captured prerequisites have settled and ordinary admission permits the destination session. Only its successful claim starts the task agent.
5. Remove ⏳ as a durable state projection and let normal task progress begin under the existing root. Do not post a separate activation notice.

Readiness is derived from durable state, not stored as a second workflow status:

```text
eligible =
  request is queued
  AND every captured prerequisite is settled
  AND its session's earlier requests permit admission
  AND no conflicting execution/artifact owner exists
  AND provider retry eligibility and admission gates permit execution
```

Extend the existing turn with its wait selection and a unique `(dependent_turn_id, prerequisite_turn_id)` relation. Index reverse lookup for affected waiters. Earlier-only prerequisite IDs and ordinary ascending session FIFO exclude cycles. Use the same admission/selection owner rather than creating another scheduler.

Freeze the outstanding accepted work in the chosen destination channel or selected visible roots, across provider sessions. Include running/delivering turns, already queued work, provider-parked requests, and unfinished artifact delivery. Newly arriving independent work does not extend this set. Steering within a captured live turn remains part of that turn. Two successive channel-wide deferred requests line up because the later one captures the earlier unfinished request.

A deferred head retains its ordinary place in its provider-session FIFO. Later requests in that session cannot jump it. Other sessions remain independently runnable. The proposal provides one experience in all managed channels; it does not make every wait depend on all work across the workspace.

“Finished” means the execution has a proven terminal outcome and owned response/artifact delivery has settled or been explicitly parked. Confirmed failure or cancellation can satisfy ordering; pass that actual outcome forward rather than claiming success. A provider-parked/retrying request remains unfinished. Ambiguous provider ownership remains blocked until existing recovery resolves it. A terminal “I need your input” answer ends an execution but does not prove its task was accomplished. Semantic conditions such as “only if tests pass” remain explicit task requirements, with prerequisite outcome evidence supplied at activation.

Concierge waits for managed parent turns, which own their tests and subagents. It does not discover arbitrary CI work, detached shell processes, or deployment completion. Deployment-success waiting remains outside the allowed lifecycle contract.

## Restart behavior

The stored request and dependencies are the authority. Events are wakeups, and emoji are projections. Neither is the queue itself.

| Interruption | Recovery |
| --- | --- |
| Concierge restarts while a request waits | Reload its original input, exact root/session, start condition, and prerequisite IDs. Do not ask the router to reconstruct intent or recapture “current work.” |
| A predecessor commits completion, then the service dies before waking the queue | Startup sees the committed outcome and reevaluates the waiter after owner recovery. The lost wakeup does not lose readiness. |
| A provider execution might still be alive | Use the existing exact provider/process recovery path. A dead Concierge process does not prove the provider stopped; the shared Codex App Server can outlive it. |
| A request is claimed, then the process dies near provider admission | Existing admission-intent/attempt fencing determines whether it is safe to requeue or must reconcile an accepted/ambiguous provider execution. Never blindly start it again. |
| Slack accepted the root but the posting helper lost the response | Correlate by the exact transport identity chosen above; retain ambiguity when identity cannot be proved. Never repost by guesswork or downgrade it to ordinary execution. |
| ⏳ add/remove fails, or a delayed add arrives after activation | Durable desired reaction state and the serialized projection owner converge on current queued/running/terminal state. An emoji failure does not change eligibility or authorize another task execution. |

Startup performs owner recovery before promotion. Healthy waiting does no recurring work: existing settlement/recovery/delivery events wake the coordinator. Existing queue maintenance remains its existing safety net; this feature adds no polling loop, waiting agent, cron job, timer, or Slack history scan.

Cost grows with explicit work: admission stores `D` chosen dependencies once; each relevant settlement visits affected waiters and their finite dependency sets; startup examines outstanding waits once. Dependency sets never grow with later arrivals. With `W` retained waiters and `T` retained turns, edges are bounded by their selected older pairs, at most `W × T`. Retain required evidence while a waiter depends on it. Waiting projection work stops on claim/cancellation. No fleet-scale abstraction is justified for this single-operator workspace.

## Slack appearance and user control

The root message exists immediately and can be opened as a thread without creating a bot reply. ⏳ is the only automatic waiting indicator. Do not set native Thinking/processing while no task agent exists. No waiting receipt, blocker-update replies, running clock, or activation announcement is sent.

Normal task progress and final responses begin only after activation. Existing necessary error notices keep their owning lifecycle policy; a healthy wait generates no additional message. The protocol cannot promise that Slack itself never surfaces reactions in personal Activity; the guarantee is no extra bot post during ordinary waiting.

If the user asks what a request is waiting for, show exact dependencies and status on demand. Existing private App Home or an invoked modal can provide this without inserting channel replies. The specific inspection/cancellation control is still a UI choice; adding it does not require one per product. A queue-cancel operation must validate exact request ownership and race atomically against provider claim. After execution has started, use native Stop. Clicking or removing ⏳ is not a control protocol.

## Scope across products

Concierge already receives managed channels through one shared handler, resolves their registry/session settings, and runs the selected provider in each project's context. Put wait admission in that shared platform path. Channel identity selects the dependency scope; existing project routing selects the destination context.

Thus the same deferred-input contract applies to #thinkering, a personal-site channel, and #slack-concierge. Product repositories need no task-specific wait code, no extra background agents, and no scheduling prompt that instructs an agent to sit idle. The inbox router needs integration only if it is one of the chosen interpreters. Direct channel input needs whichever explicit or natural-language interface is selected. Existing silent/archived channel restrictions remain in force.

The implementation would update the central service/helper and their current-state docs, plus the inbox instruction owner if applicable. It would not copy scheduler instructions into every product's AGENTS.md. The separate inbox repository was inspected read-only for its helper contract; it has not been changed.

## Acceptance before implementation can be called complete

Resolve interpretation coverage and transport first, then implement the selected design as one complete change. Do not ship a subset of input types or quietly leave direct-channel behavior inconsistent with the selected contract.

The four-lane Slack sandbox must demonstrate two independent active turns in one product channel, a deferred request already visible under its exact root with only ⏳, and zero destination-provider starts until the captured prerequisites settle. Include another product channel and a later independent request to prove shared availability without accidental global serialization. Once eligible, exactly one destination turn starts in the original thread.

Exercise both routed and direct inputs under the selected interpretation contract; ordinary messages and same-thread steering; selected roots; no-prerequisite admission; voice/files and long requests; event-before-post-response ordering; duplicate/missing control; confirmed failures versus ambiguous ownership; reload while waiting; and crashes at queue claim/provider admission. Assert no automatic waiting/activation bot reply. Prove reaction convergence and later-turn cumulative-status preservation.

Use focused deterministic regressions, exact-source sandbox evidence, the repository's one fresh-context full-diff review, correction verification, and final local gate. No production reproduction traffic is needed for this design discussion.

## Evidence and limits

The previous design turn ran `bun test tests/routing.test.ts tests/session-turn-queue.test.ts tests/queued-turn-execution.test.ts`: 14 tests and 97 assertions passed against the then-inspected source. That evidence explains the existing queue; it does not test this proposed feature. This revision is documentation only. Large source files were inspected in relevant sections rather than read in full; no LSP tool was exposed.

A prior brief Readwise check identified [First-class Agents](https://read.readwise.io/read/01kj4ss2b18d70rkxp25f3b8ek), document `01kj4ss2b18d70rkxp25f3b8ek`, as adjacent event-composition context. The design is governed by Concierge's existing lifecycle and the verified Slack transport contract, not that article's polling mechanism. A skill search for Slack surfaced messaging/agent guides rather than a relevant metadata-transport authority; no package was installed.
