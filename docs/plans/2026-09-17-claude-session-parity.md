# Why Claude-backed sessions feel worse than Codex-backed ones

Status: Tejas approved changes 1 and 2 on September 18, 2026. Change 1 (follow-ups
through Claude Code's own queue) and the owner side of change 3 (ordinary progress
carries no explanation) are implemented and live since 05:28 UTC on September 18.
Change 2 (warm process) is withdrawn: Claude's own transcript shows process start
costs 1–2 seconds, and the long wait is Claude working before its first output —
see the correction under Cause one. In its place, Tejas approved ("build") reading
Claude's transcript as the receipt: every message is acknowledged when Claude records
picking it up, so a follow-up shows as queued exactly while it waits in Claude's queue
and an opening message stops looking undelivered about a second after the turn starts. The Thinkering side of change 3 is routed to a
Thinkering session. Change 0 was not built: change 1 removes the interrupt race that
produced most ambiguity, and whatever ambiguity remains should be measured before
building a reconciliation for it.
Source: Tejas's September 17, 2026 reports, captures
`5b15308ae8b3c592e3cf63d7c8b46f8d731642e7745aeeb32634f4e8e45f890f` (session
management) and `a2c3cb409e3dfc3e39f682afc3f1ff9b60b11c0c6f670dff07a40beb9c82c6ad`
("delivery uncertain").

## The report

Sending a message to a Codex session works without ceremony — send, steer, add
another message. Sending a message to a Claude session shows a "sending" state,
then a "Queued" card with two sentences of explanation, while the session's own
indicator says the agent is working. Three complaints, in his priority order:

1. Claude session management needs rethinking; find out what Claude Code's print
   mode actually offers and why Concierge does something so different from the
   Codex path.
2. "The working status indicator says it's working, but if the message says
   sending, that's conflicting."
3. "The ridiculous three sentence descriptions of each of these. Why do we need
   those descriptions? I can make them obvious."

A second report an hour later, on the same message thread, named the state that
bothers him most and — more usefully — stated the principle this whole document
should be judged against:

> "What the fuck is delivery uncertainty? … What are we waiting on? What does
> give you certainty? When does it go missing? Have we built a proper state? Is
> it a state machine here or not? And why does uncertainty has to be concerned
> with me? Why can't you create the certainty by queuing up by making sure it
> actually does work and like get my attention when it doesn't work?"

## The governing principle

His last sentence is the requirement, and it is correct:

> **Accepted means it will be delivered. The owner keeps working until it is. If
> it genuinely cannot be, that is a failure and it gets his attention. There is
> no third state he has to hold in his head.**

Uncertainty is the system's problem to resolve, not a state to render at him.
Every recommendation below is judged by whether it moves a fact out of his head
and into the owner.

This does not mean going back to silence. `STEERING_DELIVERY_UNCONFIRMED` was
introduced for a real incident: a reply was lost between a session and the owner,
and nothing said so. Honesty about unconfirmed delivery was the right response to
that. The correction is narrower: keep the guarantee, stop reporting it. The
owner should resolve the uncertainty from evidence it already holds and escalate
only what it truly cannot resolve.

## Answer in one paragraph

Claude sessions are slower and chattier than Codex sessions for one structural
reason: Concierge runs a Claude session as *a sequence of processes*, and runs a
Codex session as *one warm thread*. Every Claude turn spawns a new CLI process
and replays the whole transcript through `--resume` before the input is even
acknowledged — a cost that grows with the conversation, from 7.6 seconds on a
session's first turn to 80 seconds by its tenth. Every follow-up message into a
live Claude turn is delivered by interrupting the agent and retyping the message,
then matching the echo by string comparison, which takes up to ten seconds and
frequently never confirms. The Codex app server has neither cost because the
thread stays warm and `turn/steer` is one round trip. The states and the prose he
is reading exist to narrate those two costs. The right fix removes the costs and
then deletes most of the narration, rather than rewording it.

The important correction to his own hypothesis: this is not a case where the
Codex app server can do something Claude Code cannot. Claude Code's streaming
input mode has a first-class command queue for exactly this, documented and
shipped, and Concierge is not using it.

And the state he objects to most — "Delivery uncertain" — turns out not to be a
delivery state at all. Of every ambiguously-delivered message retained in the
ledger, 15 out of 15 are present in the provider's own transcript. None was lost.
What is missing is not his message; it is our receipt for it.

## What he was actually looking at

The screenshot's card reads:

    Queued   This input is accepted and waiting for provider dispatch.
             This message will continue automatically when the hold clears.

That message is input `c5817b9a-3f16-43c4-a4e3-635f064dbc02`, accepted at
15:24:34 UTC into session `concierge:3265` with `delivery:"steer"`, attached to
running turn 1864 as steering row 581. Steering 581 reached `sent` at 15:24:44.
The screenshot was taken inside that ten-second window.

So every word on that card was wrong at the moment he read it. The message was
not queued — it was being handed to an agent that was working on it. It was not
waiting for provider dispatch. There was no hold to clear. The card was
describing the gap between "Concierge decided to send this" and "Claude Code
confirmed it arrived", and on the Claude path that gap is seconds long and
sometimes permanent.

Three separate layers produce those words:

| Layer | Source | What it contributed |
| --- | --- | --- |
| Input state | `readInputExecution`, `bot/src/session-owner.ts:161` | A steering row that is `queued` or `sending` reports input state `queued` |
| Reason sentence | `inputStatusDetail` → `AWAITING_DISPATCH`, `bot/src/session-owner.ts:65` | "This input is accepted and waiting for provider dispatch." |
| Retry sentence | `SessionInputStatus`, Thinkering `apps/web/src/session-input-status.tsx` | "This message will continue automatically when the hold clears." rendered from `statusDetail.automaticRetry` |

The "sending" label he named separately comes from the same component: it maps
input state `running` to the word **Sending**. Input state `running` means the
*turn* is running — the agent is working. So the component prints "Sending" over
a message the agent is already acting on, next to a working indicator that says
so. That is not two views of an ambiguous situation; it is one word chosen wrong.

## Cause one: a Claude session is a sequence of processes

> **Correction, September 18, 2026 — this section's conclusion is wrong.** The
> measurements below are time from process start to Concierge *recording* the
> acknowledgement, and they were attributed to process restart and `--resume`
> without checking Claude's own transcript. Tejas doubted it ("I don't think it's
> rereading"), and the transcript agrees with him. Across the 25 slowest recent
> Claude turns, Claude recorded the incoming message 1–2.3 seconds after the process
> started in 18 of them; the wait that followed, 15–95 seconds, was Claude working
> before its first output, which grows with conversation size and would be paid by a
> warm process too. (The remaining turns' long "startup" was the message waiting
> behind other work, not process start.) Turn 2008 from his screenshot: process start
> 05:13:07.3, Claude recorded the message and dequeued it at 05:13:08.3, first output
> 05:13:59.5, and Concierge recorded the acknowledgement at 05:13:59.
>
> Two consequences. First, change 2 (warm process) saves only the 1–2 seconds of
> startup and is not recommended. Second, the real defect is that Concierge's
> acknowledgement lags Claude's receipt by the whole thinking time: the
> `--replay-user-messages` echo reached Concierge together with the first output,
> not when Claude recorded the message. That is why the message said "Sending"
> while the agent was visibly working. Claude's transcript records the truth —
> `queue-operation` rows (`enqueue`, `dequeue`, `remove`) and the message row itself,
> with timestamps — but carries no message ID on the queue rows, so which queued
> message a row concerns follows from the queue's first-in-first-out order.
>
> The original text is kept below as the record of what was claimed.

`runClaudeCodeTurn` (`bot/src/claude-code.ts:337`) spawns a fresh `claude` process
per turn with `--resume <session-uuid>` (`bot/src/claude-code.ts:316`). There is
no process reuse anywhere in the adapter. Codex, by contrast, holds a thread on
the shared app server across turns.

Measured from the ledger, all native turns since September 14, time from turn
start to `provider_input_acknowledged_at`:

| Provider | Turns | Median | Mean | Fastest |
| --- | --- | --- | --- | --- |
| claude-code | 199 | **20.0 s** | 47.6 s | 2.0 s |
| codex | 364 | **2.0 s** | 30.9 s | 0.0 s |

A 10× difference in the time before the agent has even acknowledged the message.
And it is not flat — it grows with the conversation, because `--resume` replays
the transcript every time:

| Prior turns in that session | Turns measured | Mean seconds to acknowledgement |
| --- | --- | --- |
| 0 (first turn) | 21 | 7.6 |
| 1–2 | 23 | 16.7 |
| 3–5 | 10 | 37.7 |
| 6–10 | 7 | 79.9 |
| 11+ | 138 | 57.9 |

The monotone climb through the 6–10 bucket is the signal; the 11+ bucket mixes in
compaction and a few very long sessions, so read it as "also bad" rather than as
a reversal.

This is most of "Claude feels worse", and Tejas never mentioned it — he attributed
the feeling to the states, because the states are what he can see. A session he
has been working in all afternoon takes over a minute to notice his message.

## Cause two: follow-up messages are delivered by interrupting the agent

The two adapters implement "add a message to a running turn" in completely
different ways. Both were written in the same commit, `cf253de` (August 9).

**Codex** (`bot/src/codex.ts:883`) issues one JSON-RPC call:

```
turn/steer { threadId, expectedTurnId, clientUserMessageId, input }
```

The app server folds the message into the running turn and returns a response
naming the turn. Concierge marks the message `sent` on that response. One round
trip, a client-assigned message identity, an explicit acknowledgement.

**Claude** (`bot/src/claude-code.ts:525`) performs a two-phase handshake that
emulates a person pressing Escape and typing:

1. Write a `control_request` with `subtype: "interrupt"` and start a 10-second
   acknowledgement timer.
2. On the interrupt's `control_response`, write the message as a bare user
   message — `claudeCodeUserMessage` (`bot/src/claude-code.ts:265`) emits no
   `uuid` — and start another 10-second timer.
3. Wait for the `--replay-user-messages` echo and correlate it by **comparing the
   echoed text to the sent text** (`bot/src/claude-code.ts:694`).
4. If the echo does not match in time, set `steeringReplayCorrelationLost`, which
   refuses every further steering message on that turn
   (`bot/src/claude-code.ts:535`).

Every consequence Tejas is seeing follows from those four steps. The message
cannot be marked `sent` until two handshakes complete, so the card is visible for
seconds. When the echo does not match, the message settles `ambiguous`,
`acknowledgedAt` stays null forever, and Thinkering's `visibleInputState` — which
hides the card once `acknowledgedAt` is set — never hides it. And a single
mismatch poisons the rest of the turn.

This is not rare. Of the nine most recent native steering messages in the ledger,
six are `ambiguous` with "Claude Code did not acknowledge the steering guidance"
and three are `sent`. Every one of the ambiguous ones probably arrived; none can
be proven to have arrived.

## "Delivery uncertain": the message always arrives, the receipt usually does not

His second screenshot, 11:37, is the message that settled the thread design,
carrying:

    Delivery uncertain
    The owner attempted to send this message to the active provider turn, but
    acknowledgement is still unconfirmed. Its status will update when that turn ends.

That is steering row 586, input `4f360425`, into turn 1870 of `concierge:3172` —
the Inbox router. The router received it, acted on it and forwarded it. He was
reading a warning about a message that worked.

He is not reading an unlucky case. Every ambiguous steering message retained in
the ledger was checked against the provider's own transcript for that session:

| Ambiguous steering messages checked | Found in the provider transcript |
| --- | --- |
| 15 | **15** |

Fifteen out of fifteen arrived. His own message arrived byte-for-byte identical
to what Concierge sent — 3106 bytes each way, exact equality — at
`15:37:45.831Z`, under a second after Concierge wrote it.

Now the other half, across every native Claude steering message in the ledger:

| Steering status | Count | Echo retained as an owner message event |
| --- | --- | --- |
| `sent` | 9 | 9 |
| `ambiguous` | 15 | **0** |
| `failed` | 3 | 0 |

So the acknowledgement Concierge waits for — the `--replay-user-messages` echo of
a steering message — arrives on the stream about a third of the time. The message
itself arrives every time.

**The message has a 100% delivery rate. The receipt has a 37% delivery rate. We
have been reporting the receipt's reliability as though it were the message's.**

This was already half-known. The comment in `bot/src/session-history-projection.ts:54`,
written yesterday in `70c5609`, says it outright: "Claude can retain a steering
input in its transcript without emitting an owner message event for that item."
That session needed the fact to project history correctly and worked around it
there. Nobody carried it back to the acknowledgement path, which is still waiting
for the event that commit documented as absent.

### His four questions, answered directly

**What are we waiting on?** A `user`-type event on the CLI's stream-json stdout
whose text equals, byte for byte, what we wrote — the `--replay-user-messages`
echo. We want it from the Claude Code CLI process running that turn, and we give
it ten seconds (`bot/src/claude-code.ts:654`). For a steering message injected
after an interrupt, that event usually never comes, even though the CLI records
the message in its own transcript. We are waiting on something the provider
often does not send.

**What gives certainty?** Today, only that echo. That is the design flaw: we
chose an acknowledgement we do not control and cannot request. Three better
sources of certainty already exist. The provider's own transcript contains the
message — that is the receipt, and 15/15 of it is on disk right now. A
`uuid`-stamped async user message would make the echo self-identifying rather
than matched by string equality. And a message delivered as its own queued turn
needs no acknowledgement at all, because the owner starts the process that
consumes it — delivery is an act the owner performs, not an event it awaits.

**When does it go missing?** In the retained record, never. Not once. The write
goes into a pipe to a live local process; if that write fails, the adapter throws
and the message is marked `failed`, not ambiguous — that path exists and works
(3 messages). `ambiguous` does not mean the message may be lost. It means we
started the write and then did not recognise our own echo. Real loss is possible
in principle — the process can die between the write and the read — and that case
must stay reportable. It is not what he has been seeing.

**Is it a state machine?** Partly, and the gap is exactly where he is feeling it.
The durable steering states are `queued → sending → sent | ambiguous | failed`
(`turn_steering_messages.status`), and they are well formed as far as they go:
`markTurnSteeringMessageSent` accepts `sending` **or** `ambiguous`, with the
comment "A successful provider acknowledgement can upgrade an already-durable
ambiguous state". So `ambiguous` was designed as a *recoverable* state with a
defined exit. What is missing is anything that ever takes that exit. Nothing in
the system looks for late or alternative evidence, so in practice `ambiguous` is
terminal-by-neglect: a state with a documented transition out of it that is never
taken. That is why it reads as "no proper state machine" — the model is right and
the machine has no hand on that lever.

### What this changes about the recommendation

Both of the changes below were already the answer; this sharpens why, and adds
one interim step.

Change 1 — uuid-stamped async messages with no interrupt — is what makes the
receipt reliable, because the echo then carries an identity we assigned instead
of requiring string equality on a several-kilobyte prepared prompt, and because
the SDK's queue is the documented path for exactly this message rather than an
interrupt-and-retype it was never meant to acknowledge.

**Interim change, if relief is wanted before the adapter work: resolve `ambiguous`
from the transcript.** When a steering message is ambiguous and the provider's
retained history for that session contains its exact `replay_text`, call
`markTurnSteeringMessageSent`. The transition already exists, the matcher already
exists (`session-history-projection.ts:59`, matching a steering input by its
exact retained replay bytes when Claude assigns its own row UUID), and the
evidence is the provider's own record rather than an inference. On the current
data that resolves 15 of 15 and leaves the state for cases where the provider has
no record — which is the only case that deserves his attention.

**And the state stops being user-facing.** Under the principle above,
`STEERING_DELIVERY_UNCONFIRMED` is not something he can act on: there is no
button, no retry he should authorise, nothing to decide. It belongs in the
owner's record and in operational logging, and it should reach him only when the
owner has exhausted its evidence and concluded the message genuinely did not
arrive — at which point the honest word is **failed**, not uncertain, and it
should take his attention rather than decorate a message.

He is also right about the Codex comparison. He has never seen this in Codex
because `turn/steer` returns an acknowledgement in its response — certainty is
part of the call, not a separate event to watch for. This state exists only
because the Claude path has no equivalent, and change 1 gives it one.

## What Claude Code's print mode actually provides

Concierge already runs the CLI in streaming input mode:
`--print --verbose --output-format stream-json --input-format stream-json
--replay-user-messages` (`bot/src/claude-code.ts:316`). So the mechanisms below
are available to the adapter today; nothing here needs a new transport, a
different flag, or a Claude-side feature.

**Confirmed, from the official documentation.** [Streaming
Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) lists
as a benefit of streaming input mode: "**Queued messages**: send multiple
messages that process sequentially, with ability to interrupt". The same page
lists "Dynamic message queueing" and "Real-time interruption" as things single
message input does **not** support. Streaming input mode is described as "the
**preferred** way to use the Claude Agent SDK".

**Confirmed, from the shipped SDK type contract**
(`@anthropic-ai/claude-agent-sdk@0.3.263`, `sdk.d.ts`, the version this repository
has installed against CLI 2.1.263):

- There is a command queue for async user messages. `cancel_async_message`:
  "Drops a pending async user message from the command queue by uuid. No-op if
  already dequeued for execution."
- A message written into the stream while a turn is running is queued and runs.
  The `interrupt` receipt's `still_queued` field is "Uuids of async user messages
  that survive this interrupt: commands still in the queue… These WILL run…
  unless cancelled first", and — decisively for the current implementation — "a
  message enqueued **without a uuid** still runs but is never listed". Writing the
  message is sufficient. The interrupt is not.
- `SDKUserMessage` carries an optional `uuid`, which is the identity
  `cancel_async_message` and `still_queued` key on — the exact equivalent of
  Codex's `clientUserMessageId`.
- `interrupt()` returns a structured receipt under the `interrupt_receipt_v1`
  capability, and honors `cancel_queued: true` under `interrupt_cancel_queued_v1`,
  so a Stop can either preserve or discard queued messages and report which.
- `system/init` advertises a `capabilities` array "so SDK consumers can
  feature-detect instead of version-sniffing". Concierge never reads it —
  `capabilities` appears zero times in `bot/src/claude-code.ts`.

**Not confirmed; do not build on it without a probe.** `SDKUserMessage` also
carries `priority?: 'now' | 'next' | 'later'` and `shouldQuery?: boolean`. Neither
the shipped type definitions nor the published documentation explain what the
priority values do when a turn is already running. The plain reading — `now`
folds into the running turn, matching Codex's `turn/steer`; `next` runs as the
following turn — is a hypothesis, not a fact. A bounded probe can settle it in
minutes; until then the recommendation below uses only the documented behavior.

**So the hypothesis in the report is half right.** The Codex app server does hand
us a purpose-built RPC, and that is genuinely nicer than assembling one. But the
reason the Claude path is worse is not that Claude Code lacks the capability. It
has a documented command queue with per-message identity and cancellation, which
is in some ways *more* than `turn/steer` offers, and Concierge is not using any of
it.

## Recommended approach

The objective: a message sent to a Claude session behaves the way a message sent
to a Codex session behaves — it arrives, it is visibly acted on, and it needs no
explanation — and where Claude Code genuinely cannot match Codex, the difference
is visible as a fact rather than as prose.

One direction, three changes that ship independently and in this order. Each is
reversible on its own.

### 1. Deliver follow-up messages as queued async messages, not interrupts

Stamp every user message written into the stream with a `uuid`, write follow-up
messages directly into the live session's stdin, and correlate the
`--replay-user-messages` echo by that `uuid` instead of by text equality.

What this removes: the interrupt `control_request` for ordinary messages, the two
10-second acknowledgement timers, the text-comparison correlation, and
`steeringReplayCorrelationLost` entirely. A message is `sent` when its own echo
comes back — one hop, the same shape as Codex's `turn/steer` response.

What this gains that Codex does not have: `cancel_async_message` is a real unsend
for a message that has not been dequeued, and `still_queued` on the interrupt
receipt lets Stop report exactly which pending messages it killed or spared.

Keep the interrupt where it belongs: Stop. `onCancellationReady` already uses it
correctly and is unaffected.

This change alone ends the "Queued"/"Sending" card for live messages, because the
gap it was describing collapses to one round trip.

### 2. Keep the session process warm between turns

Hold the streaming-input process open after a turn completes, with a bounded idle
TTL, and feed the next input into it. Let it exit when the TTL expires; the next
turn after that pays today's `--resume` cost, exactly as now.

This is a cache, not a new lifecycle: the durable authority stays the ledger, a
lost process is recovered by `--resume` the way it is today, and no invariant in
`AGENTS.md` changes. It removes the 20-second median and the growth curve for the
common case of a conversation in progress.

Cost to state plainly: N warm Claude processes for N recently-active sessions,
where Codex costs one shared daemon. That is a real resource difference and the
TTL is the knob. Start conservative — a few minutes — and measure.

This change is what actually closes the 10× gap. Change 1 makes the interface
honest; change 2 makes the session fast.

#### Why change 2 is not built yet (September 18)

The claim above that "no invariant in `AGENTS.md` changes" was wrong. Reading the
spawn path showed that each turn's identity is fixed into the Claude process at
spawn, so a process reused for turn 2 would still be turn 1 in three ways:

- **Environment.** `executeAgentTurn` gives the process `CONCIERGE_ACCEPTED_INPUT_ID`,
  `CONCIERGE_TURN_KIND` and `CONCIERGE_COMMIT_PROVENANCE` for that turn. The commit
  hook stamps every commit with the provenance token it finds in the agent's shell,
  which inherits from the Claude process. A warm process would stamp turn 2's commits
  with turn 1's token, and deployment repair attributes failures by that token.
- **Attachment folder.** Each turn creates its own attachment folder, passes it to
  Claude as `--add-dir` at spawn, and deletes it when the turn ends. A reused process
  cannot see the new turn's folder and still points at a deleted one.
- **Arguments.** Model, effort, fallback model and the appended system prompt are also
  spawn arguments; a reuse must match them exactly or respawn.

None of these is hard, but each is a design decision, and together they are a change
to provenance and attachment custody rather than a cache. The smallest path:

1. Resolve the provenance token the way the hook already does for Codex — Codex's
   hook finds the single running turn for its thread in the ledger instead of
   trusting an environment variable. Claude's `CONCIERGE_SESSION_ID` is stable across
   a warm process's turns, so the same lookup keyed by session works.
2. Give each session one stable attachment folder with a subfolder per turn, so the
   `--add-dir` is fixed for the process's life.
3. Check who reads `CONCIERGE_ACCEPTED_INPUT_ID` from the environment; the session
   tools take their source explicitly, so it may be unused. Unverified.
4. Reuse a warm process only when its spawn arguments match the next turn's; otherwise
   let it exit and spawn as today.

With change 1 in place, a follow-up sent *while the agent is working* already avoids
the re-read — it joins the running process's queue. What change 2 still buys is the
next message after a turn has finished, which today waits for a fresh process to
re-read the conversation.

### 3. Make the indicators say one thing

Covered below as its own contract, since it is Tejas's second and third
questions and it is mostly Thinkering's surface.

### 0. Interim, if relief is wanted first

Resolve `ambiguous` steering from the provider's retained history, and stop
rendering `STEERING_DELIVERY_UNCONFIRMED` at him. Detailed above under the
delivery-certainty section. This is numbered zero because it is a patch on a
mechanism changes 1 and 2 remove: it buys back today's experience without being
on the path to the destination. Worth doing if the adapter work will not land
immediately; skip it if it will.

### Options considered and rejected

**Do nothing / reword the copy only.** Cheapest, and it addresses complaint 3 and
half of complaint 2. It leaves the 20-second median, the growth curve, and the
ambiguous-forever card untouched, which is the part he described as "getting
ridiculous". Rejected as the whole answer; the copy change is folded into change
3 regardless.

**Build a Claude app server analogous to Codex's.** The SDK contains references to
hosted sessions, worker teardown and multi-client attachment, which suggests such
a thing exists or is coming. Rejected for now on evidence: I could not establish
from the documentation what it provides or whether it is available to this
deployment, and changes 1 and 2 reach the same outcome using mechanisms that are
documented and already in the repository's dependency tree. Worth revisiting
deliberately, not as part of this.

**Use `priority: 'now'` to fold messages into the running turn, matching Codex
exactly.** This is likely the closest true equivalent to `turn/steer`, but its
behavior is undocumented in both the types and the published docs. Recommended as
a bounded probe alongside change 1, not as the mechanism change 1 depends on. If
the probe confirms it, "add a message" and "interrupt and redirect" become two
explicit user intents mapped to `next` and `now`, which is a better model than
either adapter has today.

**Let the CLI's queue own ordering and stop creating Concierge turn rows.**
Rejected on principle. The CLI's queue lives in one process and dies with it; it
is invisible to the owner, to Thinkering, and to a restart. Concierge's ledger is
the durable authority for what was accepted and in what order. Use the SDK queue
for the last hop only — delivery into a live session — and keep durable queueing
where it is.

### What gets deleted

The report asked whether some machinery should be removed rather than refined.
These exist only because the provider refused input, and change 1 makes them
unreachable on the ordinary path:

- `steeringReplayCorrelationLost` and its refusal message.
- Both steering acknowledgement timeouts and the grace timer
  (`steeringAcknowledgementTimeoutMs`, `steeringAcknowledgementGraceMs`).
- Text-equality echo correlation in `acknowledgedUserText` matching.
- The `STEERING_ACK_PENDING` status detail.
- `STEERING_DELIVERY_UNCONFIRMED` as a **user-facing** status detail. The
  underlying state stays — a write can still be genuinely lost, and the owner
  must keep that fact — but it stops being rendered at him. When the owner
  exhausts its evidence, the message is `failed` and takes his attention; until
  then it is the owner's business.
- Most occurrences of `ambiguous` steering itself. Today it is 15 of 24 native
  Claude steering messages. With change 1 the echo is self-identifying, and with
  the interim transcript reconciliation the ones that still occur resolve
  themselves.

Do not delete the queue fallback shipped in `d3332ec`. It is what keeps a request
alive when a session genuinely cannot take live input, and change 1 reduces how
often it is needed without making it unnecessary.

## Question two: what a person needs to know about a message in flight

A message has two facts a person could care about: *did it arrive* and *is
anything happening because of it*. Today four layers answer the first and the
session indicator answers the second, and they disagree.

The proposal: **the transcript is the acknowledgement**. Once a message is in the
conversation and the session shows the agent working, nothing further needs
saying. Show a status on a message only in these cases:

| Situation | What to show |
| --- | --- |
| Message sent, agent working | Nothing |
| Message accepted, nothing running yet, under a few seconds | Nothing |
| Message waiting behind other work long enough to matter | "Queued" plus what it is behind — a fact, not a definition |
| Message will not proceed without a person deciding | "Needs attention" plus the failure reason |
| Delivery unconfirmed, owner still has evidence to check | Nothing. The owner resolves it. |
| Owner exhausted its evidence and the message did not arrive | "Failed", and take his attention |

The last two rows are the principle applied. There is no row that says "we are
not sure, hold this in your head."

Specifically: **never label anything "Sending" while its run is running.** The
word for that state is nothing at all, because the working indicator already owns
it. The mapping `receipt.state === 'running' ? 'Sending'` is the bug he named and
it is one line.

## Question three: the descriptions

`statusDetail` was added yesterday (`a222939`, September 16) so a *failure* could
explain itself. That was right. Attaching a sentence to every ordinary state was
the overreach: a queued message does not need a definition of queued, and the
reader is the owner of the app, mid-thought, in his own session.

Recommendation, as a contract change in the owner:

- `statusDetail` carries prose **only** for states a person must act on or decide
  about: failed, uncertain, held, and paused. For those, the sentence is what it
  was built for and should stay.
- For ordinary progress states — queued, waiting, running — the owner emits the
  machine-readable `code` and, where it exists, the structured fact behind it (for
  example, what the input is queued behind). No sentence.
- `automaticRetry` stays in the payload. It stops being rendered as a sentence of
  its own.

That deletes both sentences from the screenshot: the first because
`AWAITING_DISPATCH` is an ordinary progress state, the second because it was
Thinkering narrating a boolean.

## What Thinkering would need (not implemented here)

Routing this to whoever owns the Thinkering surface:

1. **Drop the "Sending" label.** Input state `running` means the agent is working;
   the session indicator already says so. Render nothing.
2. **Do not render `statusDetail.message` for ordinary progress states.** After
   the owner change above the field will be absent for them, so this is mostly
   about not inventing a fallback sentence when it is missing — the current
   component has a hand-written default for every state
   (`session-input-status.tsx`), and those defaults would become the new source of
   the same problem.
3. **Stop rendering `automaticRetry` as a sentence.** If the distinction matters
   visually, it is a property of the chip, not a line of prose.
4. **Add a settling delay before showing any in-flight status.** A message that
   confirms in under a second or two should never have shown a card at all. This
   is what makes the remaining states rare enough to be informative.
5. **Keep the full detail for failures and uncertainty.** Nothing above reduces
   what a person sees when something actually went wrong.

The owner-side contract change (prose only for actionable states) and items 1–3
should land together, since each removes half of a sentence the other renders.

## What is recent and what is not

Worth saying plainly, because it would be easy to read this as a long-standing
mess. The split delivery paths are from August 9 (`cf253de`). Everything he
reacted to is one day old:

- `a222939` (Sept 16) added `statusDetail`, so a failure could say why it failed.
- `2b7f706` (Sept 16) reconciled ambiguous steering with its turn outcome.
- `d3332ec` (Sept 16) made a request to a busy session queue instead of being
  refused.

Each was correct against its own report. Together they took an asymmetry that
used to fail quietly and gave it a label, a reason, and a retry sentence on every
message. The states became visible before the underlying difference was fixed.

## Confidence and open questions

- The measurements, both screenshot decodes, and the two adapter implementations
  are read directly from the production ledger and the source. Confirmed.
- "15 of 15 ambiguous messages arrived" is confirmed by searching each session's
  own Claude transcript under `~/.claude/projects` for the exact steering text.
  The byte-identical comparison for his 11:37 message is an exact string equality
  check against the retained `replay_text`. The 9/15/3 echo-retention split is a
  join between `turn_steering_messages` and retained `session_owner_events`.
  Confirmed, and cheap to re-run.
- Why the echo is emitted for 9 messages and not the other 15 is **not
  established**. It is not content (bytes matched exactly), not timing (the echo
  landed inside a second), and not session identity (the initial prompt's echo
  from the same process was retained normally). Determining it is a bounded
  adapter investigation. It does not change any recommendation here — change 1
  replaces the mechanism, and the interim reconciliation does not depend on the
  cause — but somebody should know the answer before assuming a uuid alone fixes
  it.
- The SDK command queue, message `uuid`, `cancel_async_message`, interrupt
  receipts and capability advertisement are quoted from the installed SDK's own
  type contract and the official documentation. Confirmed.
- `priority` and `shouldQuery` semantics are **unknown**. A probe settles it.
- Whether this host's CLI advertises `interrupt_receipt_v1` and
  `interrupt_cancel_queued_v1` is **unverified** — a probe with closed stdin
  emitted no init event, and I did not want to spend model usage to force one.
  Feature-detect at runtime rather than assuming; the SDK says older CLIs simply
  omit the capability.
- The warm-process TTL has no evidence behind any particular value yet. Pick one,
  measure, adjust.
