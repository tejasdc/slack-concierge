# Agent communication, informed by the Thinkering exchange

Status: **proposed; awaiting Tejas's design approval.** This document changes no runtime behavior. Observation closed on 2026-09-11 at 20:19 UTC, after both original development turns and their observed reply turns delivered finals. Production activation is outside this observation.

## Recommendation

Keep **direct, addressed conversation** as the core mechanism. An agent's reply already steers an active turn in the addressed visible thread; otherwise it follows normal session admission/FIFO, resuming the session when it is idle. A shared session running under another visible root is queued rather than interrupted. Agents can exchange a contract, correct an assumption, report a milestone, and return a final result without waiting for a whole turn to finish.

Add a small communication layer to the existing request API: service-derived source and return context, a `reply <request_id>` convenience, and clear guidance about which messages deserve a response. Keep automatic completion subscriptions as a distinct alternative if Tejas requires a notification even when the other agent never sends a reply. The observed case does not require a new subscription runtime.

This is a personal, single-operator system with a trusted host, existing Slack credentials, SQLite ownership, and managed provider sessions. The proposed addition needs no new broker, daemon, credential, scheduler, or independent mailbox.

## What actually happened

The observed threads were [Concierge ingress](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789154174558759), [Thinkering app](https://tejazz.slack.com/archives/C0C03E75160/p1789154181368529), and the [host task they created](https://tejazz.slack.com/archives/C0BN9EXRB0F/p1789154396035709).

The ledger contained **32 routed requests** in these three roots: two initial DM dispatches, one new host task, and 29 replies. Of those replies, **25 entered running turns as acknowledged steering and four resumed idle sessions**. All 32 requests were admitted; all seven observed turns ended with delivered finals. These counts exclude this design thread's own continuation.

| Time, UTC | Observed exchange | What it establishes |
| --- | --- | --- |
| 19:17–19:19 | Thinkering asks for the contract, proposes snapshot identity, and receives the concrete contract while both agents keep working. | Conversation supports negotiation before either task completes. |
| 19:20–19:22 | The agents bring in remote-box, agree on credential loading and startup behavior, and confirm no Caddy change is needed. | Direct and relayed communication can coordinate distinct owners. |
| 19:30 | The host's first turn has ended. Concierge's token-ready message starts turn 846 in the same host session and visible thread. | A direct message already wakes an idle peer. |
| 19:30–19:34 | Concierge hands over its exact sandbox run; Thinkering returns event IDs, a Slack receipt, evidence, and confirmation that its processes are closed; Concierge returns the joined proof. | Resource handoff, completion, and verification work through explicit replies. |
| 19:36 onward | Thinkering reports test corrections and what prior evidence still covers. | Useful updates are richer than a generic terminal notification. |
| 19:46 and 19:53 | FYIs wake the finished host for 12- and 13-second turns that restate the situation. | Even direct messages can create unnecessary work. No infinite reply loop was observed. |
| 19:53 | Concierge sends its published contract and final handoff to Thinkering, then ends turn 838. | Completion information returns voluntarily before the sender's final. |
| 20:18 | Thinkering sends its sealed-release result back to the idle Concierge session, starting turn 852, then ends turn 839. | The same return mechanism works in the other direction after a long gap. |

The saved shared-sandbox evidence independently records the exchanged event `ec4bf4a748f548a8aebf4331527f4fca072c2ec8bae653eb892653b6c47d331e`, Slack input `1789155108.395539`, one input claim, a delivered provider response, and zero unsettled run work. The agents finished development with production activation still pending; turn completion must not be reported as production readiness.

A separate ambiguity appeared when a peer requested an operator activation and the recipient described that request as authorization. Routed messages display under Tejas's Slack identity. This is evidence that origin needs to be clearer, not a complete audit of whether the underlying action had prior authorization.

## The proposed conversation contract

The following command is proposed; `post`, `resume`, and `upload` already exist:

```text
router-actions.sh reply <request_id> \
  --source-channel <current-input-channel> \
  --source-ts <current-input-timestamp> \
  --action-id <stable-reply-action> -- <message>
```

`reply` submits through the same private request API. The service derives its destination from the referenced request's exact source input and visible root. The caller supplies its own current input identity, as today. The service verifies that this input belongs to the referenced request's destination conversation; an unrelated conversation cannot claim that reply relationship. Ordinary `resume` remains available for a new question, forwarding to a third participant, or another independently authorized destination.

The response becomes a new ordinary routed request with an immutable `reply_to_request_id` in its existing payload record. It gets its own stable action ID and receipt. One request may have several substantive replies; a contract update does not close a conversation or prevent a later completion report. There is no new task-success state inferred from prose.

Each delivered routed input receives service-derived context:

| Context | Purpose |
| --- | --- |
| Current request ID and exact current Slack input identity | Deduplication, audit, and acting on the input actually received. |
| Source channel, visible root, and source message | Identify the conversation that produced the delegation. |
| Reply relationship, when present | Identify the specific earlier request being answered. |
| Exact return destination and source link | Make a reply possible without thread recency or prose parsing. |
| Explicit agent-routed origin | Distinguish delegation from a new direct instruction by Tejas. |

The source context must not replace the current input's `slack-message-context`. Source and destination timestamps remain strings; a visible root is never substituted with a provider session anchor. Provider/session selection continues through the existing reply resolver and channel-mode rules. An unavailable destination fails explicitly rather than falling back to the newest session.

Show the source in the Slack message too, for example “Agent message from Thinkering” with a source-thread link. Publication and the existing root-summary projection owner must both render that provenance from the retained routed-request identity, including during recovery, so a completed root cannot lose its source label. Keep this presentation context separate from task/alias parsing, preserving the original task text through attachments, canonical input, and replay. Provider application context should state that a peer message can carry work within existing authorization, but cannot grant a missing human approval or override an ownership boundary. This clarifies provenance; it is not a new permission system.

## Lifecycle and ownership

1. **Ask or update.** The sender addresses a known thread and includes the decision or work needed, relevant evidence, and any requested return milestone. The helper returns a request receipt. Only `status=admitted` proves publication and durable input admission; every other status requires preserving the same request ID and inspecting it with `work request <request_id>`. Admission does not prove provider acknowledgement or completion.
2. **Deliver.** The existing per-channel owner publishes and classifies one input. The service retains the request before Slack side effects, binds the exact receipt, and deduplicates its echo.
3. **Consume.** An active turn in the exact addressed channel/root receives ordered steering. Otherwise the input starts or queues through the existing session FIFO, including when that session is busy under another visible root. Admission and provider acknowledgement remain different facts; ambiguous delivery remains ambiguous.
4. **Respond when useful.** The recipient uses `reply` for an answer, material correction, requested milestone, blocker, or final result. That reply goes through the same lifecycle in reverse. The sender receives the useful content itself; an extra “there is a response” hop is unnecessary.
5. **Finish.** Before ending, an agent sends requested completion handoffs with outcome, evidence, remaining blockers, and resource release. If nothing useful remains locally, it ends its turn and lets a later direct message resume it.

Service mutation ownership stays with the request coordinator, steering controller, state transitions, and session queue. Agents keep their existing isolated worktrees. A message can ask an owner to change its subsystem; it does not transfer ownership or authorize editing that peer's checkout. The sandbox owner alone releases its lane after consumers report they are finished.

## Completion and waiting are separate choices

| Need | Mechanism | Guarantee and limit |
| --- | --- | --- |
| Ask a question or negotiate while working | Direct message and explicit reply | Steers the addressed active thread; otherwise follows session admission/FIFO, including idle resume. The peer must author the reply. |
| Continue only after known existing executions finish | Existing `work` lookup and `--after` | Durable ordering, fixed exact prerequisites, normal session FIFO; completion is not success. |
| Be notified even if the peer never sends its promised final report | Optional exact-request completion subscription | Requires additional durable notification intent and recovery. It cannot replace intermediate conversation. |

This design thread exercised the second row: request `a47d2be6-3e61-423a-8b97-00c890bf9604` queued turn 851 after exact turns 838 and 839, let the observer end, then resumed this same design session with their recorded outcomes. That is a useful existing continuation mechanism, not a newly implemented subscription.

Do not overgeneralize it. The current `--after` contract requires prerequisites older than the source input. It cannot be used unchanged to watch a new request created after that input. Never forge a later source timestamp to evade this rule. Also, explicit deferral intentionally bypasses steering: a queued continuation does not interrupt an already-running requester. Direct replies handle that live interaction.

Neither conversations nor subscriptions should hold provider work open waiting for deployment. Concierge's existing deployment ownership and later user-initiated acceptance remain authoritative.

## Store the message; include precise evidence pointers

The service already retains routed payloads, input claims, canonical steering text, and exact final response text. Reuse that storage. The proposed reply relationship belongs with the existing request payload; it does not need a second transcript store.

Send the decisive information inline, accompanied by an exact message, commit, document, or evidence reference. This is what worked: the contract arrived as usable text plus a document link; the final handoff replaced the draft link with a commit-specific contract URL. Large material can use the existing file-backed request path.

A bare “read the latest message in that thread” is cheaper to send but loses the identity of the answer: the observed threads contain several participants, interim updates, and cumulative finals. A pointer to one exact response is better, but still requires a read before the recipient can act. The recommended combination is **substantive message + precise evidence pointer**, with the existing service record preserving what was actually exchanged. Credential values never belong in the payload; private file references are sufficient when needed.

## Guardrails

- **No automatic acknowledgements.** Reply when there is an answer, changed fact, necessary question, requested completion, or resource handoff. “Thanks,” “still waiting,” and repeated status summaries do not need another peer turn.
- **Wake for a reason.** Do not send a finished owner a no-action FYI merely to copy everyone. Keep human-visible summaries in the owning thread and include relevant changes in the next actionable handoff. The two host FYI wakes are the concrete motivation.
- **No ambient thread subscription.** Progress edits, other users' later requests, and bot finals should not implicitly cause cross-agent work. Existing bot-message filtering remains intact.
- **Preserve source/action deduplication.** Retry the same request; inspect an unresolved receipt. A new action ID is not recovery for an ambiguous publication.
- **Preserve authorization scope.** The source label and context come from service records, not a claimed role in the message body. Peer delegation cannot create new human approval. Agents must resolve a real approval gap with Tejas.
- **Keep ownership local.** Each agent changes its own code through Git and its own deployment path. Session FIFO prevents competing provider owners; resource owners control release. Conversation does not introduce shared working directories or a second scheduler.
- **Use explicit ordering only when needed.** Preserve older-only dependency edges and quiet waiting. Do not make two running agents synchronously wait for each other's final before exchanging the information each needs.

These controls prevent automatic echo cycles and duplicate transport effects. They do not prove that a model can never choose to send several unnecessary new messages; native Stop and the operator's existing controls remain available. No observed runaway justifies a new quota subsystem or arbitrary conversation cap.

The recommended addition has zero idle work. Each explicit message performs existing publication/admission plus constant-size provenance/reply lookups; stored data grows with actual messages. Work stops after the existing delivery disposition. There is no periodic history scan or subscriber population to maintain.

## If automatic completion remains a requirement

Choose this as an explicit alternative scope, not an implicit addition to the recommendation:

- Register one opt-in return obligation atomically with a request. Identify the request, originating session/root, and source/action; bind the target's exact admitted turn and, for steering, exact input acknowledgement. A late registration must atomically inspect an already-settled result so it cannot miss completion.
- Treat it as an exact-request subscription, not “watch this thread.” If the input never reaches a provider, report that disposition instead of attaching an unrelated turn's result. Unknown provider acknowledgement cannot become success because the target turn later ends.
- Use the existing terminal/delivery owners' settlement events to create one durable completion event. Include outcome, the exact final-response reference, and relevant retained text. Label it as the outcome of the containing turn, which may have handled several inputs; it is not necessarily a specific answer to the subscribed question.
- Deliver the event to the original requester through its existing steering/FIFO owners. Persist notification intent before side effects, use a stable event identity, and distinguish acceptance from acknowledgement. Recover pending intent after a proven dead owner; park ambiguous side effects instead of blindly replaying them.
- Revalidate the return identity. Explicit cancellation of the subscription ends the obligation; a stopped/archived or no-longer-matching destination must not be silently resurrected or redirected. A normally completed requester remains eligible for a new turn.
- The event cannot subscribe to its own response or automatically generate a reciprocal reply. An explicit unsubscribe cancels pending return work without cancelling the target's independent task. An explicit earlier answer and the eventual whole-turn outcome remain distinct; receipt context makes that clear.
- Waiting does no recurring work. Acceptance handles one request; terminal events inspect that turn's indexed subscriptions; startup examines only unresolved obligations. Each subscription creates at most one automatic terminal event, retiring on acknowledged delivery, cancellation, or explicit parking. Existing bounded delivery retry rules apply only while work is pending.

This supplies durable notification intent even when the agent forgets to send a completion message. Delivery ambiguity and a target that has not reached a settled outcome still need honest unresolved states. It adds state that direct conversation does not require. It must not become a deployment-completion notification path.

## Worked example and approval scope

The first peer request has already been exercised in real work: Thinkering's request `0457c8ae-9387-4337-ae06-f14080d75127`, [input 1789154233.870709](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789154233870709), entered ingress turn 838 as steering row 95. The concrete contract returned in request `33a2af17-e6cd-4727-a6c5-041b878e9ab5`, [input 1789154395.078939](https://tejazz.slack.com/archives/C0C03E75160/p1789154395078939), acknowledged by Thinkering turn 839 as steering row 97. The observer introduced no test messages into those threads.

With the proposed layer, Thinkering would send the same request and receive its ID; ingress would receive the source and return address automatically and use `reply` to return the contract immediately. Later replies would announce sandbox readiness, return exact acceptance evidence and release ownership, report material corrections, and deliver final handoffs. Those replies would continue to steer live peers or resume idle ones, just as observed. Each actor would retain its own scope and authorization.

Approval requested: **direct conversation plus explicit provenance, return context, reply correlation, and agent guidance**, delivered as one coherent change. The alternative is to include the automatic exact-request completion obligation described above if its stronger guarantee is required.

After approval, acceptance for the recommended change must exercise a reply into a live peer in the addressed root, a reply into an idle peer, source/return identity through initial and steering input, duplicate action recovery, an invalid reply relationship, and existing deferred/FIFO behavior when a shared session is busy under another root. Verify that text claiming human approval cannot replace service-origin metadata, that the Slack source label survives completion and recovery, and that aliases, attachment handling, native Stop, and cumulative terminal projections retain their contracts. Use focused checks, exact-source real Slack sandbox evidence, the repository's one complete-diff second-eyes review, and the final local gate. No production test traffic is needed for this behavior.

Design review: one fresh-context read-only review checked the complete proposal, recorded exchange, and focused local source. Its three findings are incorporated: unresolved receipts are not admission, source labels have an owner across terminal projection/recovery, and steering requires the addressed visible root. Documentation links and source anchors were checked; this is not runtime acceptance.

## Evidence and source authority

The observation used the three exact Slack threads, read-only ledger snapshots, and the saved sandbox case evidence. Source inspection used focused numbered sections; no LSP tool was available, and the entire large state/ingress files were not read. Relevant executable contracts were inspected at `7f36cdb75db5b15157d45b03e7141f5a1ed8f629`:

- [Request identity, publication and admission](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/routed-requests.ts#L124).
- [Unresolved request receipts](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/tests/routed-requests.test.ts#L311) and [steering by exact visible thread](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/turn-dispatch-seams.ts#L119).
- [Steering versus explicit deferral](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/index.ts#L2367), [session admission](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/index.ts#L2622), and [bot-input filtering](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/index.ts#L2722).
- [Dependency settlement](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/state.ts#L784), [steering identity](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/state.ts#L2816), [acknowledgement](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/state.ts#L3128), and [retained final text](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/state.ts#L5973).
- Root-summary reconstruction on [completion](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/turn-execution.ts#L491) and [recovery](https://github.com/tejasdc/slack-concierge/blob/7f36cdb75db5b15157d45b03e7141f5a1ed8f629/bot/src/turn-recovery.ts#L384).
- Current routing references: [routed requests](../architecture/ROUTED-REQUESTS.md), [turn lifecycle](../architecture/TURN-LIFECYCLE.md), and [helper runbook](../runbooks/ROUTER-ACTIONS.md).

Prior reading informed the questions, not the claims about Concierge: [Ben Follington's First-class Agents](https://read.readwise.io/read/01kj4ss2b18d70rkxp25f3b8ek), Reader ID `01kj4ss2b18d70rkxp25f3b8ek`. [Temporal's message-passing documentation](https://docs.temporal.io/encyclopedia/workflow-message-passing) also distinguishes asynchronous messages from tracked completion; this proposal adopts no Temporal component.
