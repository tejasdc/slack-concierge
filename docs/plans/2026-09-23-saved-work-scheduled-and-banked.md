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
afternoon.**

**No exclusion is needed, and that is better than the edit this design first asked for.**
`concierge:3633` checked rather than agreeing: the predicate is *positive* — it touches only
rows already carrying `dispatch_failure_class='retryable'` — and the only writers of that value
sit in the dispatch-failure path (`state.ts:3698`, `:3745`), where a provider has actually
refused a turn. A saved turn is queued with a future instant and **no dispatch failure behind
it**, so it is outside that query by construction, as it is outside the same positive predicate
at `provider-usage-notice.ts:81` and `session-owner.ts:1276`. Verified independently here
against the shipped file.

So the obligation is the honest one and it sits on this side: **never set a dispatch failure
class on a turn that is waiting because we chose the time.** That field means "a provider
refused this and it can be retried"; a scheduled turn has no failure at all. They have recorded
the invariant where the field is written, so a future author reusing the column meets it.

**Why it is saved is a durable field, not the failure class.** The usage-hold requeue
overwrites both columns wholesale (`state.ts:3697-3698`), so a banked turn released at 03:00,
dispatched, and then refused for usage would lose the fact that it is banked — gaining an
escape from its own rule (when the hold clears it would run immediately, in his morning) and
breaking the reset-credit guard below, which needs exactly that fact. So the reason a turn is
saved is **one field set when it is saved and untouched by any requeue**. A banked turn that
passes through a usage hold returns to its banking rule, not to the queue floor.

That single field then does five jobs (the sixth it was carrying, keeping saved turns out of
`releaseScheduledProviderRetries`, turned out to need no field at all — see above): it gives `statusDetail` (`session-owner.ts:101-112`) a branch so
a saved wait explains itself instead of falling through unexplained, supplies the predicate for
`heldWorkIsAllBanked`, distinguishes a decline from a failure, tells the watch what to look at,
and excludes saved rows from `waitingOnLiveRequest`.

**Its `statusDetail` branch is checked before the retryable one.** After a banked item is
released and refused for usage it carries both, and the retryable branch at `:101` would
otherwise tell him "no Claude usage left until the time below" while pointing at a *banking*
instant once the rule moves it.

**The saved kind is a separate projection field, not a new `execution` value.** `execution`
stays `queued`; three readers test membership on it (`request-liveness.ts:45`,
`session-communication.ts:830`, `session-peers.ts:764`), and a new value there is the
wire-contract-plus-membership-test case the repository's one-source-of-truth rule exists for.
The saved kind rides beside `backgroundWait` / `pendingCount` (`session-owner.ts:595`).

**The ask's request row still exists, and comes with liveness machinery.** Using the queue for
the *wait* does not remove the request row for the *ask*: `ask()` inserts one unconditionally
with `due_at_ms = now + 30 min` (`session-communication.ts:651-653`). Left alone, a 5:15pm test
saved at 09:00 reports itself `overdue` at 09:30 (`inspectOverdue`, `:1138` — a queued turn is
neither `running` nor `done`, so `healthy` is false), and its requester is permanently "waiting
on a live request" (`request-liveness.ts:36`), which suppresses stall detection for every other
request that session owns. Two corrections, and deliberately not a third:

- **A saved item's `due_at_ms` is its own rule's instant.** Both inspections already filter
  `due_at_ms <= now`, so this alone closes the overdue problem.
- **Saved rows are excluded from `waitingOnLiveRequest` until released** — the join resolves
  (`target_input_id` is `request:<id>`, retained with that id on both creation paths), which
  makes this a *sixth* job for the saved-reason field and constrains where that field may live.
- **`AWAITING_INSPECTION` is left alone.** It is a bare SQL fragment interpolated against two
  tables with different id spaces — `session_communication_requests` and
  `session_peer_requests`, whose `target_session_id` is a *remote* id — so a saved-row predicate
  there would need a join that silently matches a local session whenever the numbers collide.
  Those two readers diverging once is the nine-hour incident this design keeps citing.

**The inspection timer needs the same cap the queue already uses.** `arm()` computes
`delay = due - now` and calls `setTimeout` uncapped (`session-communication.ts:1219-1223`;
`session-peers.ts:953-955` likewise). Node fires a delay over ~24.85 days immediately, so a
saved item held longer than that makes the inspection timer fire at once, find nothing due,
re-arm and spin — the same incident shape. Cap it at a day and re-arm, exactly as
`session-turn-queue.ts:81` does. This is why open item 5 (how long a banked item may wait) has a
technical floor as well as a preference.

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
- Its session view says it is `scheduled` or `banked`, so an agent reading the catalogue cannot
  mistake one for a working session — his second sentence. That is a projection field of its
  own; `execution` stays `queued` for the reason given below.

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

The hours, the reserve and the waiting period are **settings with starting values**, not
constants and not questions for him — see [Starting settings](#starting-settings-not-questions).

**Which account — agreed and shipped.** `concierge:3633` settled this on 2026-09-23 (`08f56e6`,
request `01a72976`) with a smaller shape than proposed: one concept, a turn **bound** to an
account, with two reasons for being bound.

```ts
chooseAccountForTurn({ accounts, bound: { account, reason } | null })
```

A banked release passes `reason: "spending-this-window"`; a continuing conversation passes
`"this-session"`. A bound turn whose account has room runs there with that reason as its
`because`; a bound turn whose account has none returns `bound-account-has-no-room` and **never
falls through to the roomiest account**, which is the guarantee banking needs — landing
elsewhere is not graceful degradation, it is the opposite of what the release was for. Verified
against the shipped file: `provider-account-choice.ts:96-101`. Unbound turns are unchanged.

Two of their refinements are better than the proposal and are adopted: the rule takes no
*window*, because which allowance is being saved is this design's business and naming it there
would be a second place that knows about banking; and the refusal has one name for both kinds of
binding, so a later edit cannot fix one caller's guarantee and miss the other's.

What he reads when it refuses, in their words: *"Waiting for tejas@chann.app to refill.
tejastej.dc@gmail.com still has room, but this was held back to use tejas@chann.app's allowance
before it expires, and running it elsewhere would waste the thing it was saved for."*

**Which window** stays this design's own. A banked row records the account *and* the window it
was released to spend; only the account crosses into the binding, while the window is what this
design's own rule, reserve and boundary-yield are about. Without the binding, admission would
have taken the account with the most room in its tightest window — a different quantity that
routinely names a different account, so banking would have fired and let the allowance it was
saving lapse anyway.

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

  **This needs a trigger that recurs, and the queue's own wake is not one.**
  `nextQueuedTurnAttemptMs` selects instants *in the future* (`state.ts:4836`), and `armDeadline`
  arms no timer when that is null (`session-turn-queue.ts:71-79`). So the fault case ends the
  wakes: the instant arrives, the timer fires, the claim returns null (a drain, a parked head, a
  paused session), nothing is in the future, no further timer exists, and nobody comes back. At
  that single wake the item is zero minutes past, so a "more than N minutes past" read would not
  have matched it either. The native-only runtime has no periodic poll to fall back on —
  `session-runtime.ts` contains no timer of its own (checked: zero `setInterval`/`setTimeout`),
  and the 60-second queue wake is in the Slack composition only.

  **The trigger is the usage watch**, which is the one self-re-arming timer the native runtime
  does start: `startProviderUsageWatch` runs regardless of whether anything is queued and calls
  `onReading` per reading (`provider-account-usage.ts:308-314`), already wired natively at
  `session-runtime.ts:72` beside `publishUsageForecastNotices` and `publishExpiringResetNotices`.
  The banked rule's re-evaluation already hangs there; the watch read joins it. One read per
  reading for saved turns whose instant is more than N minutes past, reported **once per item**
  through the attention path and **never re-dispatched** — re-dispatching open work on a
  predicate is the incident at `request-liveness.ts:26-31`, which *"made every deployment's run
  claim fail on a busy database"* for nine hours. "Once per item" needs its own durable mark; the
  saved-reason field cannot carry it.
- **A banked item that has found no window within its waiting setting** (7 days to start) is not a fault, it is a decision for
  him: run it now, schedule it instead, or drop it. It reaches him through the existing
  attention path, not a dialog.
- **Nothing else interrupts him.** Everything up to that point the system is handling, which is
  the standing rule for outcomes he does not have to act on.

## What ends each wait

| Kind | Ends when | Or |
| --- | --- | --- |
| Scheduled | the instant passes and the claimer takes it | he starts it now; he drops it; its expiry passes, and it is reported `missed` rather than run late — "test the 5:15pm refill" is worthless at 9am |
| Banked | the rule's instant is reached and still passes re-evaluation at claim time | he starts it now; he drops it; it passes its waiting setting and becomes a decision |
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

### What "resumable" means for a run that already shipped something

This was a hole in the first two drafts and it is the sharpest consequence of his "same as
daytime" answer: a banked run can commit, push and deploy before it is stopped, so **its opening
message must never be replayed** — replaying it could repeat those effects. That is not a new
rule invented here; it is the repository's existing invariant (`AGENTS.md`): *"Stop cancels its
exact run; later messages and returns remain eligible in the same durable session; a new input
never replays the stopped input or an uncertain effect."*

`concierge:3635` confirmed the shape on 2026-09-23 (request `991c00d6`), and corrected the
premise this was nearly built on: there is **no** mechanism anywhere by which a resumed turn
checks what it already did. One is *queued* for them — a request to auto-resume turns that die
on provider errors, held behind another, so it had not reached them when they answered — and it
covers turns that **died**, where this design covers a run **stopped on purpose at a boundary**.
The two do not conflict, and when that request reaches them it is their call whether to reuse
the continuation input below. Today, Concierge only re-runs an input the provider
*provably never processed* — no assistant output, no tool call, judged from the turn's own
record. Nothing keys on external effects at all: a git push or a release activation is recorded
nowhere a resume could consult. A yielded banked run that did real work falls squarely under
"never replayed".

So a yield resumes **as a new input in the same session, not as a replay**, which is the
mechanism this design already has for appending to a saved session:

- The yield stops the run and returns the item to waiting, exactly as described below.
- When its next opportunity arrives, the saved session receives a **continuation input** — new
  words saying it was stopped at an allowance or deployment boundary and should carry on from
  where it got to. The agent reads its own history to know what it already did; nothing
  reconstructs that for it.
- The opening input is never queued twice.

Two things make that safe rather than hopeful, and both are `concierge:3635`'s point: effects in
this workspace are already idempotent under a stable identity — pushing commits already on the
remote is a no-op, and a release activation is keyed by commit — and the continuation says where
it stopped rather than asking for the work again.

**One hold, one meaning — `concierge:3635` took this generally.** Wiring the call surfaced a
collision worth recording because it was invisible: `queueTurnContinuation` marks its new turn
`retryable` with the wait time, and `releaseScheduledProviderRetries` moves *every* queued
`retryable` turn with a future instant to now when an account is switched or the usage cache is
cleared. A continuation waiting until 3am would therefore have run in the middle of his
afternoon, with nothing logged and nothing failing.

Rather than patch it per caller, they are giving every queued hold a single meaning in
`docs/plans/2026-09-24-waiting-and-retrying.md`: `backoff` (a transient retry, and the *only*
thing an account switch or usage clear releases early), `auth_wait`, `usage_wait`, and
**`chosen_time`** — a time someone chose, released by that time alone. A boundary continuation
carrying `waitUntilMs` becomes `chosen_time`.

That is strictly better than this design's own rule, and supersedes it: "saved work never
carries the retry mark" was this design protecting itself from a field with two meanings;
`chosen_time` removes the second meaning for everyone. **Until it ships**, a boundary
continuation here is converted to a saved turn with its class cleared immediately after the
call. **When it ships, that conversion is deleted** — otherwise two owners hold the same timing,
which is the duplication this repository refuses.

**The entry point exists, and it constrains how a yield must end.** `concierge:3635` shipped
`queueTurnContinuation(sourceTurnId, {kind:'boundary', detail, waitUntilMs?})`
(`bot/src/session-inputs.ts`, `a061743`). Three constraints come with it, and the second already
caught a real defect here: it refuses a turn whose Stop was requested by a person, because a
deliberate Stop must never continue; it requires the source turn to be the session's latest and
to have ended `done` or `error`; and a waiting continuation is cancelled when a newer input
arrives in that session, which is correct for us — if he sends something to a banked session, his
words win.

The defect: this build's boundary yield ends its turn as `cancelled`, which is neither `done` nor
`error`, so the call would have returned null **silently** and a yielded run would have sat held
forever. So a boundary yield must end its turn as `done` — it did finish a unit of work and was
asked to stop — and must not travel the human Stop path. Found by checking against the
constraints rather than assuming; it is the kind of failure nobody notices until they ask why
banked work never picks itself up.

One distinction this design keeps that nothing else models: **stopped on purpose, mid-work** is
not the same as *died*. A boundary yield is deliberate, its session is healthy, and it is the
only case where the system stops a run it could have let finish.

**Yielding needs a write of its own, and it is not the retry path.** "Stopped cleanly, resumable,
returns to waiting" has to name how the row gets back to `queued`: the only existing
requeue-a-running-turn write is `retryRunningTurnAfterProviderFailure`, which saved work must not
use (it stamps a failure class and an error, and refuses outright once artifacts exist,
`state.ts:3684-3694`). So a yield writes `status='queued'` plus the rule's next instant, with no
attempt counter and no error text. Without that write a run yielded at 02:00 is not queued at
all, and is therefore invisible to the watch, which looks only for queued turns whose instant
has passed.

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
| Which account a banked release spends | **`concierge:3633`, shipped `08f56e6`** | their file; agreed and in code |
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
- **The three settings** — quiet hours, how much is held back, how long an item waits before it
  asks — sit in Settings with their current values, changeable there, with the change confirmed
  where he made it (D11's second half: a promise in a status message is a commitment in the
  code, and a setting that silently did nothing is the same defect).

## Starting settings, not questions

Three of the numbers in this design were first written down as things to ask him. They are not
decisions; they are **starting settings with sensible values, visible and changeable where he
can reach them**. Asking him to pick a number before he has watched the feature run once is
asking him to guess, and none of them is hard to change later.

| Setting | Starts at | What moving it does |
| --- | --- | --- |
| Quiet hours | **00:00–06:00 local** | Widens or narrows when banking may treat an idle machine as evidence that nobody wants the allowance. |
| Held back | **25 %** of the window | The dial between "banked work finishes things" and "banked work is never in his way". Lower it and more gets done overnight; raise it and more room is always waiting for him. |
| Waits before it asks | **7 days** | How long a banked item stays quiet before it becomes a decision in his attention list. Seven days is one full cycle of a weekly allowance: an item that has found no window in a whole cycle is not going to find one without something changing. |

**Where they live.** Concierge holds them, beside the rule that reads them — one home, no second
copy. He sees and changes them in Thinkering's Settings, which shows the current values and
commits the change through the owner, exactly as Provider accounts already does for something
Concierge owns and he manages from the app. A change is confirmed where he made it; a setting
that silently did nothing is indistinguishable from one that did not save.

Each saved item's own row still says why it is waiting in words ("Tonight, if Claude's weekly
allowance is still unspent"), so the settings screen is where the numbers live, not where he has
to go to understand a particular item.

## What a banked run may do unattended — answered

Tejas, 2026-09-23: **"Same as daytime."**

A banked run follows the same delivery rules as work he asked for in the afternoon. Small,
reversible changes ship all the way through to live; anything sensitive or hard to undo waits
for his OK, exactly as it would at 3pm. There is no separate night-time policy to learn, and no
agent has to reason about what time it is to know what it may do.

**Each banked run leaves a note of what shipped.** Not a notification — he is asleep — but a
record on the run itself, so the morning question "what happened overnight?" is answered by
looking at the item rather than by reading a diff. A run that yielded at a boundary says what it
got through before it stopped.

That answer also settles the cost of yielding, which this design makes routine: a run stopped at
an allowance or deployment boundary has either shipped its small change already or is waiting on
his OK anyway, so stopping loses a resumable conversation rather than half-delivered work.
