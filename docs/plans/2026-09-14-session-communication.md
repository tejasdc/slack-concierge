# Session communication for Concierge-owned sessions

Status: **implementation authorized; current delivery narrowed by Tejas on September 15.** This is one complete delivery, with the existing Concierge runtime and catalogue retaining ownership.

The approved narrowing is recorded in the [comparison thread](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789440937716179?thread_ts=1789432448.682319&cid=C0BNN5K4JSJ): Tejas approved sending five concrete recommendations after reading the comparison. The [forwarded instruction](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789441042763959?thread_ts=1789154481.755879&cid=C0BNN5K4JSJ) contains those recommendations. The earlier broader proposal is preserved at [43538dd](https://github.com/tejasdc/slack-concierge/blob/43538dda3ea9acd50dfa51aa6d86f68ed46436a5/docs/plans/2026-09-14-session-communication.md); it is historical context, not the current implementation scope.

## Current delivery

An agent can discover an existing conversation, inspect its evidence, ask a question, end its turn or continue other work, and receive a correlated answer or an explicit problem later. Questions and partial replies can arrive back to back while both sessions are running.

Concierge owns this path for the provider sessions it already manages. Thinkering may consume the transport-neutral addressed contract; this delivery does not relocate the catalogue, claim Thinkering-owned provider sessions, or add a second native executor. Thinkering's separately authorized native session product remains independently owned.

The complete scope is:

- Discovery and bounded context over the existing router index: accepted inputs, acknowledged steering, and delivered TL;DRs.
- Exact session/conversation addresses, derived sender provenance, source-scoped immutable action identity, and durable requests.
- Correlated partial/final replies, atomic return obligations, asynchronous delivery to active or idle requesters, and preserved failure/ambiguity evidence.
- Exact request prerequisites held before provider admission, preserving the existing session FIFO and avoiding reply-dependent queue deadlock.
- One durable due time and one overdue inspection after 30 minutes. One armed timeout serves the earliest outstanding deadline; it does no work without pending deadlines.
- Additive integration with existing routed publication, input claiming, steering, provider execution, and recovery owners.
- Focused regressions, exact-source real Slack sandbox acceptance, one fresh-context Astra second-eyes review, full local gate, and integration/push through normal delivery.

Archive transcript search, CASS, historical reconstruction, provider adoption experiments, ownership migration, new attention-generation machinery, and a general deadline-extension policy are excluded from this delivery. The original implementation request included archive search; the later approved narrowing supersedes that scope for this Concierge change. Resurrection experiments remain separate, with meaningful source-grounded follow-up as the success criterion rather than exact historical tool replay.

## Identity and discovery

A session ID addresses the existing durable Concierge session row, which retains provider binding and branch ownership. A discovery address also pins the exact conversation selected from evidence. Its opaque encoding is an identity carrier, not a secret or a permission token. The caller never decides whether the provider is running, should resume, or should receive steering.

Search ranking returns candidates; it does not choose identity. Context uses the same bounded, completeness-checked corpus. Empty, incomplete, ambiguous, or non-messageable results require more evidence or clarification. No newest-session fallback is allowed. Provider IDs and mutable channel modes cannot silently redirect an accepted address.

The coordinator derives the sender session, run, user, and exact visible conversation from an accepted source input. Agents cannot claim another sender session in the API body. Peer and service inputs retain explicit agent origin; they grant no new human authorization. The private owner-only request socket remains the transport boundary, with no new public endpoint or credential.

## Request and result ownership

Acceptance writes one immutable request containing the exact sender, target, message, dependencies, and due time. That row is also the mandatory return obligation. Recording precedes all publication, so even a reply during admission can find its obligation.

The existing routed-request owner publishes the input, claims it, and admits it through the existing native queue or exact-root steering path. The communication coordinator does not execute a provider. The routed request identity, target turn, input kind, provider acknowledgement, semantic answer, and return delivery are separate facts.

A partial reply commits a correlated event without settling the question. A final reply commits its exact answer and return event in one transaction. One request has one final disposition. Retries with the same source/action and payload return the same operation; conflicting payloads fail.

A containing turn can hold many questions. A correlated final answers only its own request. Whole-turn completion leaves the other questions unanswered and returns “ended without a confirmed answer” with an exact retained-output reference. Automatic final extraction is restricted to a turn dedicated to one question with no steering inputs. It never assigns one general final to every question in that turn.

Return events use the same durable publication/input path. Active requesters receive steering and idle requesters resume through their existing session queue. Returns do not create another question or another return obligation. A stopped or archived requester retains the result until the existing human continuation boundary permits delivery.

Admission remains distinct from confirmed provider receipt. Unsent failed steering returns can move once into the existing ordinary queue under their original published input after the prior execution settles; ambiguous sends remain tracked without replay. Stop eligibility is rechecked at native admission, and a held publication cannot block the human continuation that releases it.

## Waiting, failures, and loops

An agent may finish its turn immediately after acceptance. No model or shell process owns the wait. Request status can be inspected without resending it.

A continuation's finite prerequisite set is fixed at acceptance and references already-existing requests from the sender. It stays outside the provider FIFO until every prerequisite settles. An unsuccessful prerequisite returns a decision-needed outcome rather than admitting the continuation as successful. The existing execution-based work/--after contract is unchanged, including exact older-than-source execution selection.

A 30-minute due time triggers one inspection of recorded admission/execution/owner/Stop facts and one durable overdue event. It does not infer death from silence, retry uncertain provider effects, override deliberate Stop, or create an indefinite repair loop. Late confirmed answers remain deliverable. Existing native recovery owns reconciliation and safe continuation.

Publication ambiguity retains the existing routed request and its exact receipt. Startup and later lifecycle signals inspect that identity; they never create a second action to make progress. Different destination channels remain independent. A held return remains visible in the request record.

Automatic reply acknowledgements and reciprocal subscriptions are absent. Replies and service events cannot create another return obligation. Tejas explicitly rejected an automatic conversation quota on September 15; follow-up questions have no hop limit. Deadlines, explicit cancellation and native Stop provide visibility and control without treating model prose as new authority.

## Existing behavior and acceptance

The ordinary Slack path remains behaviorally identical. Exact-root steering, fork/comparison isolation, shared-session mode, input-claim ordering, original work/--after behavior, and existing recovery remain their current owners' responsibility. Only communication-originated requests carry an extra pinned-session admission check.

Acceptance must demonstrate:

1. Search/context produce exact evidence and a stable addressed session; mode changes cannot redirect it.
2. Several questions share one running target turn; answering one leaves the others pending.
3. Whole-turn completion produces an explicit unanswered result and output references for every unconfirmed question.
4. An answer during admission cannot outrun its durable return obligation.
5. Duplicate sends/replies and restart recovery preserve one request and one final return.
6. Live return steering and idle requester resumption use existing native execution, with no competing writer.
7. Waiting prerequisites stay outside provider FIFO; later inputs can supply the answer that releases them.
8. Failed/ambiguous effects remain distinguishable, deliberate Stop/archive hold returns, and later confirmed answers remain usable.
9. Deadline intent and notice are durable, one overdue inspection occurs, and no timer remains when no deadline is eligible.
10. The changed behavior passes exact-source real Slack sandbox cases, existing compatibility tests, and the required whole-diff review.

The observed September 11 Thinkering exchange remains the worked example: contract questions, shared sandbox ownership, and final completion reports use direct addressed conversation. Informational “done” acknowledgements do not create further subscribed work. The original observations are preserved in [the September 11 record](2026-09-11-agent-communication.md).
