# Work that waits: one primitive, and the rules layered on it

**Status:** designed 2026-09-23, nothing built. Second draft, after an independent review
returned `NO-SHIP` on the first (`tmp/reviews/saved-work-review.run.log`, six findings, all
accepted) and after Tejas added the requirement that settles the shape.

Supersedes the banking half of
[thinkering/docs/plans/2026-09-16-banked-work-and-usage-observation.md](https://github.com/tejasdc/thinkering/blob/main/docs/plans/2026-09-16-banked-work-and-usage-observation.md).

## What he asked for

First, that scheduled and banked work be one design:

> "Banked conversations are different from scheduled conversations. Schedule is waiting on a
> time. But banked conversations are waiting for … opportunities, are opportunistically saved
> for later, to make sure that we are not wasting any … credits and usage. If our credits are
> going to be expired then we bank it. But all of them should work in the same design here. I
> think banking will also rely on scheduling here."

Then, that it be built on what already waits, as a primitive rather than a third mechanism:

> "even the usage limits that's running out. And when do we retry? How do we retry? … when we
> know, okay, this can be only retried after like certain time, when the usage limits is done.
> Then we need to use that information to … schedule it. … So understand how that system is
> working today. … we need to think in terms of like abstractions and like … how do we kind of
> like build and layer features on top of like a fundamental primitive that can be made
> reliable here. And … the system should also be aware of … ongoing requests or pending
> requests for things that are queued up and … wake up or … see if there's something is going
> wrong and like being able to … investigate debug or like even notify."

**He is right that it already exists, and the first draft missed it.** That draft proposed
extending the request store with new rules. This one adds almost no mechanism at all.

## What already waits, today

| What waits | How it waits | Where | Whose |
| --- | --- | --- | --- |
| A turn blocked by a spent allowance | queued, with `dispatch_next_attempt_ms` set to the reset instant | `provider-usage.ts:82` (`clearsAtMs`) | `concierge:3633` |
| A turn whose dispatch failed and can be retried | queued, `dispatch_failure_class='retryable'`, next attempt backed off | `state.ts:4847-4852` | queue |
| Work whose reason for waiting disappeared (account switched, cache cleared, credit spent) | its instant is moved to now — **nothing is replayed** | `releaseScheduledProviderRetries`, `state.ts:4847` | `concierge:3633` |
| A request waiting on other executions | `turn_dependencies`, settled inside the claim | `settleTurnDependencies`, `state.ts:4856` | wait-for-existing-work |
| A request with no answer after 30 minutes | `overdue_at_ms` / `stalled_at_ms`, reported to its requester | `request-liveness.ts`, `session-communication.ts:1136` | request protocol |
| A deployment waiting for work to finish | the claimer refuses every new turn while a drain is pending | `claimNextQueuedTurn`, `state.ts:4857` | deployment |

## The primitive

Five of those six are the same thing, and it is already written down:

> **A queued turn with an instant before which it is not claimable.**
>
> `claimNextQueuedTurn` refuses a turn whose `dispatch_next_attempt_ms` is still in the future,
> refuses everything while a deployment drain is pending, and settles turn dependencies inside
> the claim transaction. `nextQueuedTurnAttemptMs` reports the soonest such instant, and
> `SessionTurnQueue.wake()` sets a timer for it — its own doc comment says why: *"a wait with a
> known end — a usage allowance reset hours away — needs someone to come back at that instant;
> without it the work resumes only when something unrelated happens to wake the queue, which on
> a quiet machine can be never."* (`state.ts:4825-4839`)

Everything below is a **rule that computes that instant**. No rule starts work, holds a
process, or owns a clock of its own.

| Kind of wait | The instant is | New? |
| --- | --- | --- |
| Usage hold | the allowance's reset | no |
| Retry | now + backoff | no |
| After other work | unset; `turn_dependencies` gates the claim | no |
| **Scheduled** | **the time he or an agent named** | **new rule, existing column** |
| **Banked** | **the next moment the opportunity test can pass, recomputed as readings arrive** | **new rule, existing column** |

This is what makes the answer to his deployment question fall out rather than be designed:
**waiting is a row in `turns`, so nothing holds a run open** — `resolveDrainIfIdle`
(`index.ts:520`) counts only `activeTurnCount` and `activeInputHandlerCount`, and a queued turn
touches neither — **and a drain already stops the claimer**, so a banked burst at 00:30 cannot
accumulate ahead of a release. Both properties are inherited, not added.

Two consequences of using the real queue rather than a parallel store:

- Saved work already appears as queued work he can see, stop and reorder.
- A crash between "the instant passed" and "the turn ran" leaves a queued turn, which is the
  state it was already in. There is no `releasing` state to reconcile.

It also **carries a wait of days**, which is the property scheduling needs and which was checked
rather than assumed: the wake timer caps at 24 hours and re-arms on arrival
(`session-turn-queue.ts:80-87`), so "next Tuesday" is a chain of daily re-arms, not one
oversized timer.

### Three prices this primitive charges, which must be paid explicitly

Reusing a column means inheriting its existing semantics. Each of these is a real behaviour in
the code today, and a saved turn that ignores it breaks something that works.

**A saved turn is not a retry, and must not be labelled as one.** The only writer of a future
`dispatch_next_attempt_ms` today is `retryRunningTurnAfterProviderFailure` (`state.ts:3671`),
which always sets `dispatch_failure_class='retryable'` in the same statement, and three readers
key on that pair. The dangerous one is `releaseScheduledProviderRetries` (`state.ts:4847`),
which moves *every* queued retryable turn with a future instant to now for a provider, and is
called when the operator clears the usage cache or an account is activated
(`provider-usage.ts:132`, `:143`). If saved turns carried that class, **switching accounts at
2pm would fire the 5:15pm test immediately and release every banked item into his working
afternoon.** So saved turns do not carry it, and that function excludes them.

**Why it is saved is a durable field, not the failure class.** The usage-hold requeue
overwrites both columns wholesale (`state.ts:3697-3698`), so a banked turn released at 03:00,
dispatched, and then refused for usage would lose the fact that it is banked — gaining an
escape from its own rule (when the hold clears it would run immediately, in his morning) and
breaking the reset-credit guard below, which needs exactly that fact. So the reason a turn is
saved is **one field set when it is saved and untouched by any requeue**. A banked turn that
passes through a usage hold returns to its banking rule, not to the queue floor.

That single field then does five jobs: it keeps saved turns out of
`releaseScheduledProviderRetries`, gives `statusDetail` (`session-owner.ts:101-112`) a branch so
a saved wait explains itself instead of falling through unexplained, supplies the predicate for
`heldWorkIsAllBanked`, distinguishes a decline from a failure, and tells the watch what to look
at.

**The ask's request row still exists, and comes with liveness machinery.** Using the queue for
the *wait* does not remove the request row for the *ask*: `ask()` inserts one unconditionally
with `due_at_ms = now + 30 min` (`session-communication.ts:651-653`). Left alone, a 5:15pm test
saved at 09:00 reports itself `overdue` at 09:30 (`inspectOverdue`, `:1138` — a queued turn is
neither `running` nor `done`, so `healthy` is false), and its requester is permanently "waiting
on a live request" (`request-liveness.ts:36`), which suppresses stall detection for every other
request that session owns. So: **a saved item's `due_at_ms` is its own rule's instant**, and
saved rows are excluded from `AWAITING_INSPECTION` and `waitingOnLiveRequest` until released.
The request row is kept deliberately — it is how the agent that banked the work learns the
outcome.

**Saved work lives in its own session, always.** The FIFO guard that makes appending work
(`state.ts:4868-4872`) is the same clause that would strand every later input behind a saved
head if anything banked work into a working session. This is an invariant, not a convention.

## What is genuinely new

1. A **saved session**: a session and its input exist before the work runs, with a release rule
   attached.
2. The **banked rule**, which computes an instant from usage rather than from a clock.
3. **His own way in** — saying "bank it" — and an agent's way in, both producing the same row.
4. A **watch** that notices a saved item that is not going to happen, and tells him.

### 1. A saved session, which can be added to before it runs

His words on 2026-09-16, which the first draft dropped entirely:

> "We can obviously route to the same schedule session, right? The agents should just know that
> this is a schedule session and you should not confuse the schedule session with the real
> session or working session. But we should still be able to like you know append to any
> schedule session."

So a saved item is a **session**, not a bare request:

- It is created when it is saved, in whichever project it names — the existing
  `sessions ask --provider --project` path already creates one, which is also what makes "any
  project in my workspace, not just thinkering" true without new work.
- Its first input is queued with the rule's instant. **Appending** is an ordinary further input
  to that session, from him or from an agent; the queue's own FIFO then runs them in order when
  the session wakes.
- Its session view reports `scheduled` or `banked` where a working session reports `running` or
  `queued`, so an agent reading the catalogue cannot mistake one for the other. That is his
  second sentence, and it is a projection field, not a new concept.

### 2. The banked rule

One sentence: **release when an allowance would otherwise reach its reset unspent, and nobody
is expected to want it first.**

The test has a **base** that always holds, and **two alternative triggers**. The first draft
made all of it conjunctive; the review showed that this makes any window whose reset falls
outside `[01:00, 08:00]` local permanently unbankable — for a weekly allowance resetting at a
fixed hour, *never* — and that his own sentence offers alternatives, not a conjunction:

> "start looking at two hours early and like you start looking into existing sessions **if there
> is no existing sessions start early** and if its nighttime especially then also **and
> nighttime and no sessions then that should be most time**"

**Base — all of these, always:**

| Condition | Why | Value |
| --- | --- | --- |
| Nothing is executing and nothing of his is queued | "there's no active sessions running" | fleet-wide; an unreachable Mac counts as idle, because a sleeping Mac spends nothing |
| The forecast says the window reaches its reset unspent | this is the waste banking exists to prevent | from `sessions usage`; **never released on a stale or failed reading**, matching how `chooseAccountForTurn` refuses an account whose reading failed (`provider-account-choice.ts:52`) |
| The allowance is above the reserve | banked work may never be the reason his own work waits | stop at **25 %** headroom remaining |
| At least a floor of time remains before the reset | "30 minutes might not be enough time" | **≥ 1 h** |

**Trigger — either of these:**

- the local hour is inside the quiet band (**00:00–06:00** by default), **or**
- the reset is within **2 h** ("start looking at two hours early").

The quiet band is still doing real work, because his correction on 2026-09-16 is real:

> "if usage is gonna expire in three hours at 3 a.m. and there's no active sessions you can
> confidently say that oh there is not going to be any more active sessions … versus 3 p.m. you
> cannot say that because I can come back"

At 3pm, idleness predicts nothing. What protects him at 3pm is therefore not the clock but the
**reserve** — banking stops with a quarter of the window unspent, so arriving at 3:30pm he
finds room. The band remains the dominant case ("that should be most time"); the proximity
trigger is what keeps every window reachable.

**Which account, and which window.** The release must spend *the allowance it was released to
save*. `chooseAccountForTurn` picks the account with the most room in its tightest window
(`provider-account-choice.ts:79-87`), which is a different quantity and routinely a different
account. So a banked row **carries the account and window it is spending**, and admission
honours it. That is `concierge:3633`'s file, so the mechanism — a pinned account on the row, or
a fourth `because: "spending-this-window"` — **is theirs to choose, and is an open item below,
not something asserted here.**

**Readings must be dense while it runs.** The reserve cannot be enforced against a half-hourly
reading; a banked run can cross 25 % well inside it. The existing tightening (five-minute
readings past the halfway mark) is extended to *any* window a banked run is spending, for the
duration of that run.

### 3. Both ways in produce the same row

> "we need to come up with a verb term for it so I can quickly go from hey this need report a
> bug or like we can quickly add a task and say this has to be scheduled for when usage is
> available kind of thing right let's come up **so both me and the agents can learn what to do
> when**."

- **His way**: the Inbox router recognises "bank it" and "schedule this for …" in his own
  words, exactly as it already interprets "take a note" and "report a bug". No prefix, no form.
- **An agent's way**: `sessions bank` / `sessions schedule`, beside `sessions ask`.

The verb is his, with his reason: *"I will also use bank. I think bank it is also pretty cute.
because we are still banking on it by making use of it right?"*

### 4. It notices when something is not going to happen

This is the last part of his addition — *"see if there's something is going wrong and like
being able to … investigate debug or even notify"* — and it is where the request store's
liveness idea belongs, rather than on the rows themselves:

- **Pending, running, queued** is already answerable: the queue holds every waiting turn with
  its instant and reason. `sessions usage` already answers the allowance half. A saved item's
  row names its rule, so "what is waiting and why" is a read, not a new ledger.
- **A scheduled item whose time has passed without running** is a fault: the instant is in the
  past and the turn is still queued. Something is wrong — a drain that never finished, a parked
  head, a paused session — and it is reported with what the queue says about it.

  **This needs its own trigger, because the queue's wake cannot serve it.**
  `nextQueuedTurnAttemptMs` selects instants *in the future* (`state.ts:4836`), so a turn whose
  instant has passed and which is still queued is invisible to the timer — which is precisely
  this fault case: the instant arrived, the claim returned null, `nextAttemptMs()` returned
  null, and nobody comes back. So on each wake and on execution-changed, **one read** for saved
  turns whose instant is more than N minutes past. Reported **once per item** through the
  attention path, and **never re-dispatched** — re-dispatching open work on a predicate is the
  incident recorded at `request-liveness.ts:26-31`, where it *"made every deployment's run claim
  fail on a busy database"* for nine hours.
- **A banked item that has found no window in N days** is not a fault, it is a decision for
  him: run it now, schedule it instead, or drop it. It reaches him through the existing
  attention path, not a dialog.
- **Nothing else interrupts him.** Everything up to that point the system is handling, which is
  the standing rule for outcomes he does not have to act on.

## What ends each wait

| Kind | Ends when | Or |
| --- | --- | --- |
| Scheduled | the instant passes and the claimer takes it | he starts it now; he drops it; its expiry passes, and it is reported `missed` rather than run late — "test the 5:15pm refill" is worthless at 9am |
| Banked | the rule's instant is reached and still passes re-evaluation at claim time | he starts it now; he drops it; it is still waiting after N days and becomes a decision |
| Usage hold | the reset instant, **or** the reason disappearing (`releaseScheduledProviderRetries`) | unchanged |
| Retry | the backoff instant | unchanged |
| After other work | `settleTurnDependencies` in the claim | unchanged |

**Re-evaluated before it runs — split by what each place can actually see.** A banked instant is
a prediction; between setting it and reaching it, he may have come back. But the two halves of
the base live in different places and must be checked in different ones:

- **In the claim transaction**, only the condition that changes fast and matters most: *is he
  back?* His running and queued work is rows in `turns`, readable inside that synchronous
  transaction (`state.ts:4855`).
- **In the rule**, on each usage reading and on execution-changed: peer reachability over
  Tailscale and the forecast. Neither is readable inside the claim transaction, and neither
  should be attempted there.

**A decline is not a failure.** A banked turn that declines moves its instant by a write that is
not the retry path — no attempt counter, no error text. Otherwise an item that politely declines
forty times over a week would tell him *"The last attempt failed … (tried 41 times so far)"*
(`statusDetail`, `session-owner.ts:111`).

**The banked instant is quantized** — the band's start, or `reset − 2h` — not a continuous
function of a drifting forecast. Otherwise "writes only when the instant changes" is not
achievable, because a forecast moves on every reading.

**A banked run ends at the boundary it was spending against.** The point was to spend an
allowance before it expires, not to start eating the fresh one at the reset. It is stopped
cleanly, stays resumable, and returns to waiting. Work that cannot tolerate that should be
scheduled, not banked — that is the practical difference between the two, and it belongs in the
first line of the guidance an agent reads.

**A banked run also yields at a deployment boundary, by the same mechanism.** Refusing to
*release* during a drain is not enough: a banked turn already running when the drain opens sits
in `activeTurnCount` and holds `drainAndStop` for as long as an Opus turn takes. That is
`concierge:3633`'s observed cost — *"a burst between midnight and six can hold a Concierge
release for hours, which has already cost him two evenings"* — and the fix is the yield the
design already has, triggered by `deploymentWait()` (`session-owner.ts:804-816`). Scheduled work
does not yield: he named its time, so a deployment waits for it as for any ordinary turn.

**Until a conversation can move accounts, a resumed banked item waits for its own account.**
The move branch was removed in `709adad`; the [shared-history fix](2026-09-23-accounts-share-one-history.md)
is expected to restore it. Nothing here depends on movement.

## Across restarts and updates

- **Nothing waiting holds a process.** Updates install freely; the wait is a row.
- **A missed instant fires on the next start.** The queue wakes, and every instant already in
  the past is claimable immediately. This is the `Persistent=true` property, supplied by the
  queue rather than by a second timer. A systemd timer could additionally *start a stopped
  unit*, which an in-process wake cannot; that is the one real advantage of the alternative and
  it does not outweigh having two owners of the same decision.
- **The wake is exact, not polled.** `nextQueuedTurnAttemptMs` + the queue's existing timer
  means "5:15pm" means 5:15pm, not the next tick. Banked rules need re-evaluation as readings
  arrive, so they also recompute on each usage reading — a read that writes only when an
  instant changes. That restriction is deliberate: a predicate that rewrote rows on every pass
  is exactly the incident recorded in `request-liveness.ts:26-31`, where re-dispatching open
  requests *"made every deployment's run claim fail on a busy database"* for nine hours.

## The reset-credit interaction

`provider-reset-policy.ts` spends a scarce Codex reset credit when work has stopped with
nowhere to go. Banked work must not be able to justify that spend — but the first draft put the
exclusion in the wrong place with the wrong test, and the review was specific:

- There is no "work has really stopped" branch in `provider-reset-policy.ts`;
  `decideAutomaticReset` tests provider, `alreadyDecided`, `accountsWithRoom` and candidate
  presence. The stopped-work judgement is at the call site, `useResetIfWorkStopped`
  (`provider-usage-notice.ts:140-160`).
- The right predicate is **not** "the refusing turn was banked". If banked work exhausts the
  account at 3am and one of *his* inputs is held at 06:30, that hold is real stopped work and
  the credit **should** be spent. The test is "**everything currently held is banked**".

So: a `heldWorkIsAllBanked` field on `ResetSituation` (`provider-reset-policy.ts:36-47`, which
takes plain inputs, so a fourth `because` slots in cleanly), decided at that call site. The
information is *nearly* at hand rather than already computed: `heldInputCount`
(`provider-usage-notice.ts:79-84`) is a count keyed on the instant, called from
`noticeUsageHold` — a different function — so this predicate needs the held turn *ids* plus the
saved-reason field above. The stake is higher than waste: the episode key `alreadyDecided`
refuses a repeat, so a credit spent on banked work removes the account's only escape hatch for
his own work.

## Who owns what

| Part | Owner | Why |
| --- | --- | --- |
| The queued-turn primitive, its claim, its wake, its drain refusal | **already shipped** | nothing to build |
| Usage holds, retries, account choice, `sessions usage` | **`concierge:3633` / shipped** | read, never reimplemented |
| Which account a banked release spends | **`concierge:3633`, by agreement** | their file; open item 1 |
| The scheduled and banked rules, the saved session, `sessions bank` / `schedule`, the watch | **slack-concierge** | beside the queue they compute for |
| Recognising "bank it" in his own words | **the Inbox router** | it already interprets his verbs |
| The list he reads and its controls | **thinkering** | his words: "Concierge should own the observer of the spare queue and the thinker can just own the surface where we see this information" |
| A new timer, unit or store | **nobody** | none is needed |

## What he sees

Checked against the `interface-decisions` skill; rule numbers are its.

A saved item appears in the sessions list as a session that exists before it runs — his own
request: *"we can add like a scheduled session a session bar which is scheduled and I can those
gives me a good like look at all the different things that are scheduled and like you know when
they might start acting on and if I want to I can like start just say here let's start with the
minute right now."*

- **Named by what it will do**, with its project, never by an id (D6). The destination is named
  before it runs, and the working and not-working cases read differently (D7): *"Tonight, if
  Claude's weekly allowance is still unspent"* · *"At 5:15pm"* · *"After the release finishes"*
  · *"Waiting since Tuesday — no window found"*.
- **Queued-for-a-reason is distinguishable from queued-behind-work.** The queue already shows
  queued turns; a saved one says what it is waiting for, because otherwise his own queue grows
  items he cannot explain.
- **Controls are marks with tooltips, never words** (D1, D2): `Play` start it now, `Clock`
  change when, `Trash2` drop it. The destructive mark is not adjacent to `Play` (D8).
- **Dropping destroys** (D5), behind a notice that carries its own undo with the countdown drawn
  on the control, five seconds minimum (D4, D10).
- **A banked item that has found no window** becomes a decision in his attention list, with run
  it / reschedule it / drop it — and nothing before that point interrupts him (D11).
- **Banked work that ran overnight** appears in history like any other session; one that was
  stopped at a boundary says so in its own row (D6).

## Open — his to decide, or to agree with `concierge:3633`

1. **Which account a banked release spends** — with `concierge:3633`, since it is their rule.
   Without it banking can spend the wrong subscription and the allowance it was saving lapses
   anyway. This is the one item that blocks implementation.
2. **The quiet band.** 00:00–06:00 local is a guess.
3. **The reserve.** A quarter of a window is a guess, and it is the dial between "banked work
   finishes things" and "banked work is never in his way".
4. **What a banked run may do unattended.** It runs at 3am with nobody watching. Does a banked
   "fix this bug" commit, push and deploy through the normal path, or stop at a pushed branch
   for the morning? Asked on 2026-09-16, still unanswered, and it changes what gets built.
5. **How long a banked item waits before it becomes a decision** rather than keeping quiet.
