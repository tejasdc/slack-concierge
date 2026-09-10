# Wait for existing work

Status: design only, not implemented. Revised 2026-09-10 after Tejas specified one Concierge API accepting the message and dependencies together, with the service posting as the user and owning execution admission. The router never independently posts or attaches dependencies afterward. This supersedes the bot-authored proposal in `ff3e331` and the message-trigger-first framing in `fff0da5`.

A routed request appears promptly as the user's message in its destination channel. Its request message carries ⏳ while waiting; work starts automatically in that same thread. Waiting is opt-in across Concierge-managed channels. There is no waiting receipt, Thinking indicator, blocker-update post, or activation announcement.

## Fixed executions, not perpetually busy sessions

Suppose C is submitted while executions A1 and B1 are running. The router selects A1 and B1. If later messages start A2 or B2 in those sessions, C still depends only on A1 and B1.

| Event | Effect on C's explicit prerequisites |
| --- | --- |
| A1 completes; B1 is still running | Wait for B1. |
| A2 starts in A1's former session | No new dependency. |
| B1 completes while A2 continues | Explicit prerequisites are satisfied. |
| B2 starts afterward | Does not re-block C. |

The destination's own provider session still obeys ordinary FIFO and cannot run two conflicting turns at once. That admission constraint is separate from watching A/B's sessions. Work that arrives after C has entered that FIFO cannot overtake C. If C uses an independent session, it can run alongside A2/B2.

Steering acknowledged within A1 is part of A1; a separately accepted later request is a different execution. The router resolves exact existing work rather than selecting “whatever is newest in this session” at each check.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Inbox router | Interpret destination, new/resumed work, and explicit waiting intent; resolve agents/sessions to exact executions; call one request API with the task, files, and direct prerequisites. |
| Concierge service | Own that whole operation: durable acceptance, posting as the user, exact Slack identity, admission, prerequisite enforcement, and Slack state. It makes no second natural-language decision. |
| Destination task agent | Begin the actual task only after admission permits execution. No agent is launched to monitor waiting. |

The work lookup returns exact execution IDs, channel/root/session evidence, current state, request/title evidence, and Slack links. It reports completeness and distinguishes an empty current-work snapshot from unresolved identity. “These two agents” means the union of the two resolved selections, including selections from different channels. A provider name alone is not a unique agent identity.

Use sanctioned historical thread search when needed to identify the described work, followed by exact execution lookup. Preserve its source-message cutoff and clarification rules. A completed source can be a satisfied dependency without being resumable; resuming the destination still requires proven resumability. Never guess by recency or silently omit an unresolved prerequisite.

The selected IDs are frozen at lookup. If they finish before submission, their conditions are satisfied. The service validates and stores the selected set; it does not replace them with new work. Missing or mismatched references cause an explicit error. A complete empty selection is an explicit instruction with nothing to wait for.

The router supplies direct edges: C depends on A1 and B1. If A1 itself waits for X, its existing dependency supplies the transitive ordering. No copied full graph is needed. Direct channel prose retains its existing interpretation; this feature does not introduce another classifier.

## One request API and execution owner

Provide `POST /requests` in the running Concierge service. The existing router `post`/`resume` helpers become thin clients of this API for all routed requests. They perform no Slack publication themselves. Ordinary requests send no prerequisites; explicitly deferred requests send their exact set. Concierge uses the existing user token and text/file presentation, so every routed request still appears authored by the user. Server ownership and visible authorship are independent, as Slack's [user-token documentation](https://slack.dev/two-keys-to-one-platform-understanding-bot-and-user-tokens/) confirms.

Conceptually, the router supplies:

```json
{
  "action_id": "stable-source-action-id",
  "destination": {"channel_id": "C_PRODUCT", "root_ts": null},
  "task": "Audit the testing mechanism.",
  "defer": true,
  "depends_on": [
    {"turn_id": 410, "channel_id": "C_SOURCE_A", "root_ts": "1789000000.000001"},
    {"turn_id": 417, "channel_id": "C_SOURCE_B", "root_ts": "1789000010.000002"}
  ],
  "source": {"channel_id": "D_INBOX", "message_ts": "1789059185.484779"}
}
```

These identifiers are illustrative. Real execution references come from the lookup. A resolved root replaces `null` for a resume. An ordinary routed request has an empty dependency list. An explicit deferral remains a separate task even if its selected dependencies have already completed; retain that routing decision separately from list emptiness so it cannot accidentally become steering.

The service owns the operation from acceptance through admission. This sequence illustrates a Slack event arriving before the posting response:

```mermaid
sequenceDiagram
  participant R as Inbox router
  participant C as Concierge channel intake owner
  participant D as Existing SQLite state
  participant S as Slack
  R->>C: submitRequest(message, dependencies, source/action)
  C->>D: Commit request, dependencies, publication intent
  C->>S: Post with user token
  S-->>C: Message event (recorded; cannot dispatch)
  S-->>C: Exact posting receipt
  C->>D: Bind Slack identity and admit request once
  Note over C: Release publication ownership; existing queue checks eligibility
  C-->>R: Request identity and publication result
```

No dependency relation is inferred from the visible task text or emoji. The router understands language once; service code checks exact ledger references.

## Preventing competing admission

The invariant is:

> One service-owned request contains its message and dependencies before any Slack side effect. Only its admission owner can create the corresponding execution.

An API wrapper alone is insufficient if an independently running Slack handler can still dispatch its publication. Both API publication and Slack-input classification must pass through one serialized owner per destination channel. A new root has no thread timestamp yet, so channel is the narrow known coordination key. Other channels have independent owners. This is a small in-process ownership boundary in the existing service, not a new scheduler or an actor framework.

The owner performs these steps in order:

1. **Accept atomically.** After validating the source, target, files, and exact prerequisite identities, commit one request with its immutable dependencies and publication intent in the existing SQLite database. All are accepted together or none are accepted. No provider turn or fake Slack timestamp is needed before publication.
2. **Publish as the user.** The service performs the existing text/file posting operations. It retains channel intake ownership across the asynchronous publication and receipt recording. Database transactions are short and commit before network calls; no SQLite write lock is held across Slack I/O.
3. **Record and admit once.** Save the exact Slack message/root returned by the text API or proven by reserved file shares, and bind the request to the shared durable input/admission path. That path creates at most one ordinary turn with the already-stored prerequisites, or performs the existing ordinary routing action. Explicit deferral cannot become steering. Record the request-to-input/turn ownership before releasing the channel owner.
4. **Release and evaluate.** Wake the existing execution queue and return the request's machine receipt. The queue can start an eligible task immediately or leave it ownerless with ⏳. Neither the API call nor the channel owner waits for prerequisite execution to finish.

Slack events received during publication can be acknowledged and durably recorded, but their handlers cannot classify, steer, capture, or create turns concurrently with that owned operation. Once ownership is released, an event carrying the recorded `(channel_id, message_ts)` is an observation of the existing request. It cannot create another execution. A direct human message with another exact identity proceeds through the same admission owner and existing policy. A human reply arriving immediately under the new root consequently sees an established root/session binding.

This is explicit serialization across asynchronous calls. JavaScript being single-threaded does not establish it: `await` otherwise permits another handler to run. The service must enforce the shared owner for both entry points. API admission does not depend on receiving its Slack echo; the confirmed Slack receipt supplies the exact identity. Events never reconstruct the request's dependencies from text, metadata, timing, or user/channel similarity. Remove the previous proposal's “potentially matching message” searches and fallback classification.

The publication critical section delays new input classification in that channel for the duration of the Slack operation. It ends at durable admission or steering handoff; provider execution and turn completion run outside it. Already-running providers and their progress continue; other channels continue; waiting for A1/B1 never retains this ownership. This explicit scope is the cost of ordered publication, not a workspace execution lock.

### Durability without a second authority

The request plus persisted publication intent is the transactional-outbox pattern applied inside Concierge's existing database: commit the state and intended external effect together, then perform the effect. [AWS's pattern guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) describes that atomic local write and the need for idempotent consumers. Its example's extra broker and polling process are not needed here; acceptance and recovery events drive the existing service owner.

For the asynchronous critical section, [Cloudflare's concurrency guidance](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile) explicitly distinguishes synchronous storage from external calls that yield and may require excluding interleaving. This is evidence for the ownership principle, not a proposal to migrate Concierge to Durable Objects. Outbox persistence alone does not serialize an independent Slack handler; both parts of the design are required.

Idempotency uses runtime realm plus exact source message plus stable split-action ID. Identical retries return the existing request; a different payload under the same key is rejected. A router disconnect does not abandon an accepted operation. The service owns durable copies of files before acknowledging acceptance; after publication and input handoff, the existing attachment lifecycle owns them. The normal machine receipt distinguishes durable acceptance from confirmed Slack publication and never generates an automatic Slack receipt reply.

Persist the publication attempt and exact owner identity before sending. On process restart, recover incomplete publication ownership before allowing that channel's input classification to proceed. Confirmed Slack identities resume binding/admission on the same request. Proven non-delivery permits the recorded operation to be attempted. Ambiguous delivery remains unresolved and cannot admit the request, repost it blindly, or release an unproven publication echo into ordinary input handling. It may require exact recovery or operator resolution for that channel; other channels and already-bound work remain independent. A database transaction cannot make Slack's network write atomic, but this uncertainty never turns into an executable request with missing dependencies.

Normal receipt identity uses the existing [user-token text/file posting primitives](https://github.com/tejasdc/slack-concierge/blob/ff3e331/bot/scripts/router-post.ts#L165). Reserved upload IDs give exact share recovery. A client-generated request marker, when Slack returns it, can provide additional exact evidence after a lost text receipt; it is not required for ordinary admission and is never permission to execute. No correctness claim depends on metadata appearing in every event or on text matching.

Expose this API through a private local Unix socket owned by the existing service and runtime profile ([Bun support](https://bun.sh/docs/runtime/http/server#unix-domain-sockets)). Derive requester authority from the exact accepted source input and the existing authorized user token, not a freely chosen caller identity. Keep production and sandbox sockets/state separate. No new daemon, public endpoint, credential, periodic worker, or dependency-watching agent is introduced.

## Where the code checks

The inspected source already provides the right execution shape:

- [Input handling](https://github.com/tejasdc/slack-concierge/blob/ff3e331/bot/src/index.ts#L2286) durably claims the Slack input. Put its classification behind the same channel owner as API publication, and pass the accepted request's identity/dependencies into this shared path. This precedes [live steering](https://github.com/tejasdc/slack-concierge/blob/ff3e331/bot/src/index.ts#L2350), so an explicitly deferred request cannot be injected into a running turn.
- [Initial admission](https://github.com/tejasdc/slack-concierge/blob/ff3e331/bot/src/state.ts#L4166) inserts an ordinary queued turn before attempting provider ownership. Attach the prerequisites and check eligibility there.
- [Queued promotion](https://github.com/tejasdc/slack-concierge/blob/ff3e331/bot/src/state.ts#L4311) checks session FIFO, active turns, artifacts, and admission gates. Apply the same prerequisite rule before its ownership transition.
- The [existing queue coordinator](https://github.com/tejasdc/slack-concierge/blob/ff3e331/bot/src/session-turn-queue.ts#L16) wakes and runs eligible claims. Prerequisite settlement wakes this owner; there is no separate deferred-task dispatcher.

```text
can_start =
  input and routing information are resolved
  AND turn is queued
  AND every captured prerequisite has settled
  AND the destination session's existing admission rules permit execution
```

Waiting is the existing ownerless queued state plus a unique `(dependent_turn_id, prerequisite_turn_id)` relation. Index the reverse relation to find affected waiters. Validate older-only prerequisites when creating a turn; combined with ordinary ascending FIFO, this prevents cycles. Keep capture, duplicate handling, explicit deferral, and ordinary steering decisions within the shared intake policy.

A current-work snapshot includes accepted queued/running/delivering work, provider-parked work, and unresolved owned artifacts in its explicit scope. Pending routing publications must be reported as unresolved lookup evidence rather than silently excluded from a supposedly complete snapshot; resolve or clarify before selecting exact execution IDs. Work arriving after the lookup does not enlarge the chosen set.

“Settled” means a proven terminal execution outcome and settled or explicitly parked owned delivery. Confirmed failure or cancellation satisfies ordering while preserving that actual outcome. Provider retry, ambiguous provider ownership, and provider-parked work remain unfinished. An answer asking for input ends that execution without proving task success. Conditions such as “only if tests pass” remain task requirements, with prerequisite outcome evidence supplied when the task begins.

Dependencies refer to managed turns, including the tests/subagents those turns own. They do not discover detached processes or wait for deployment success.

## Restart and Slack behavior

The database preserves the exact input, dependency edges, publication/binding evidence, and provider ownership. Events wake owners; emoji only project state.

| Interruption | Recovery |
| --- | --- |
| Router disconnects after accepted posting handoff | The service retains the posting intent; retrying the same source/action retrieves it. |
| Slack event arrives before the API posting receipt | Record it behind the active channel owner. After the owner records the receipt/admission, the event observes that same request and creates no execution. |
| Service restarts during unresolved publication | Recover the dead channel owner before reopening that channel's input classification. Reconcile exact receipts/shares; park ambiguous outcomes without executing or blindly reposting. |
| Service restarts while a turn waits | Reload the original prerequisites. Do not reinterpret the text or select new work from the source sessions. |
| Completion commits but its queue wake is lost | Startup rechecks durable prerequisite outcomes after ownership recovery. |
| Provider may still be alive | Use existing provider/process admission recovery; process exit alone does not authorize a duplicate launch. |
| A reaction update is lost or arrives late | The existing durable projection converges to the turn's current state; it does not control execution. |

⏳ appears on the user's request: the root for a new thread, or the request reply for a resume. A healthy wait produces no additional reply, activity clock, or Thinking state. On successful claim, clear ⏳ and begin normal task progress in that thread. Keep the existing user-authored root and cumulative-summary writer.

Ordinary replies to a waiting new thread follow its session FIFO; after activation, normal live steering remains. An explicitly deferred resume queues its task even if the root already contains active work. Existing ordinary steering is not reclassified as a dependency instruction.

Inspection and cancellation can be explicit, on-demand controls using exact turn ownership. A cancellation races atomically with the queue claim; after activation use native Stop. Removing ⏳ is not a command.

Healthy waiting adds no polling, watcher agent, timer, or recurring Slack history scan. Acceptance stores one request/publication record and its finite input/files and D selected edges; settlement checks affected waiters; startup examines outstanding state. Files follow existing cleanup after ownership handoff; keep the publication receipt with its source/input deduplication evidence and retain dependency evidence while referenced. The channel owner is held only for publication/admission, never prerequisite waiting. Waiting projection work ends on claim/cancellation. An unresolved publication is parked for exact recovery instead of spawning an indefinite retry loop.

## Whole-change acceptance

Implement no runtime changes from this design discussion. The eventual whole feature includes the one request API, service-owned user-token publication, serialized admission, exact dependency lookup/submission guidance, queue promotion, quiet Slack projection, and recovery. Product repositories need no scheduler or new classifier. Update the shared service/helper docs and the inbox router's instruction owner in that delivery.

Acceptance in the four-lane Slack sandbox must prove:

- A user-authored request in channel C waits for exact executions A1/B1 from different channels, shows only ⏳, and starts once in the same thread after those executions settle.
- A2/B2 arriving in the source sessions do not extend or reintroduce C's dependency wait. A separate case preserves destination-session FIFO.
- Ordinary and deferred requests both use the API; the router performs no independent Slack post or later dependency mutation. They have the same author, root/file presentation, input ownership, and downstream provider dispatch path.
- Named references, ambiguity, empty selections, completed references, completion between lookup and post, chains, and mismatched identifiers behave as specified.
- Text, audio/files, and long requests retain their exact input and attachments; early Slack events and duplicate events cannot bypass dependencies.
- Force both event-before-receipt and receipt-before-event orderings. The shared owner must exclude competing admission, acknowledge the publication echo without another turn, and admit once even if the echo is withheld. Include duplicate echoes and a direct human reply during publication.
- Prove ownership is released before prerequisite waiting: new inputs in that channel and work in other channels remain available. During publication, acknowledged inputs remain durable until their ordered processing resumes.
- Explicit deferred resumes cannot steer a running task; ordinary steering remains intact.
- Helper disconnection, publication interruption, service restart, lost settlement wake, and provider-admission interruption recover without reconstructing intent or duplicating execution. Unresolved publication ownership must survive restart and exclude fresh classification until exact recovery; do not treat a process-local mutex alone as recovery.
- No receipt/activation post is generated; reaction and cumulative-summary projections remain correct across later turns.

Use focused regressions, exact-source Slack sandbox evidence, the repository's one fresh-context whole-diff review, corrections, and the final local gate. This revision is documentation only; no Slack write or runtime test establishes the proposed transport yet.

## Evidence limits

Source inspection used targeted sections and verification searches; large files were not read in full and no LSP tool was exposed. Earlier routing/queue tests passed 14 tests and 97 assertions against the previously inspected source; those results establish existing behavior, not this feature. Documentation checks validate links, stale-design references, and the diff.

The earlier Readwise/skill discovery context remains adjacent background only. The authority for this design is the user's corrections, the existing Concierge lifecycle, and the cited primary Slack/Bun contracts.
