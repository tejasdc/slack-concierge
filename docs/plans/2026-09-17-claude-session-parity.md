# Why Claude-backed sessions feel worse than Codex-backed ones

Status: research and recommended approach. Nothing here is implemented.
Source: Tejas's September 17, 2026 report (capture
`5b15308ae8b3c592e3cf63d7c8b46f8d731642e7745aeeb32634f4e8e45f890f`).

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

### 3. Make the indicators say one thing

Covered below as its own contract, since it is Tejas's second and third
questions and it is mostly Thinkering's surface.

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
- Most instances of `ambiguous` steering. Not all: a write can still be lost, so
  the state and its `STEERING_DELIVERY_UNCONFIRMED` contract must stay. It stops
  being the common case, which is the point — today it is the majority.

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
| Message delivered but unconfirmed | "Delivery unconfirmed" plus the reason |

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

- The measurements, the screenshot decode, and the two adapter implementations
  are read directly from the production ledger and the source. Confirmed.
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
