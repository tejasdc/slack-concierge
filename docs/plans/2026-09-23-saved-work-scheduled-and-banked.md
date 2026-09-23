# Work that waits: scheduled and banked, one design

**Status:** designed 2026-09-23, nothing built. Supersedes the banking half of
[thinkering/docs/plans/2026-09-16-banked-work-and-usage-observation.md](https://github.com/tejasdc/thinkering/blob/main/docs/plans/2026-09-16-banked-work-and-usage-observation.md);
that document's usage-observation half shipped and is now owned by
[the usage forecast](2026-09-23-usage-forecast-and-account-switching.md).

Tejas asked for one design covering both, today:

> "Banked conversations are different from scheduled conversations. Schedule is waiting on a
> time. But banked conversations are waiting for … opportunities, are opportunistically saved
> for later, to make sure that we are not wasting any … credits and usage. If our credits are
> going to be expired then we bank it. But all of them should work in the same design here. I
> think banking will also rely on scheduling here. So we need to design systems to support all
> different use cases and have generic enough to be extensible and support all these things."

## The problem that has no answer today

He asked how work that must wait for a time — a test at 5:15pm, when an account's allowance
refills — happens "without waiting on a background thing that blocks all of the deployments",
and "do you have a system for scheduling safely outside of the Concierge deployment windows?"

There isn't one, and the reason is mechanical. An agent that waits has two options:

- **Keep its run open.** `activeTurnCount` stays above zero, and `resolveDrainIfIdle`
  (`bot/src/index.ts:521`) only completes a drain when it reaches zero. A run sleeping until
  5:15pm therefore holds every Concierge update behind it.
- **Set a timer inside the run.** It dies when the run ends.

So waiting must be **a row, not a process**. Nothing runs, nothing is held open, updates
install freely, and the wait survives them because it was never in memory.

## What changed underneath this, and what it does to banking

[Two accounts, one history](2026-09-23-accounts-share-one-history.md) and
[the usage forecast](2026-09-23-usage-forecast-and-account-switching.md) landed between his
banking conversation and today. `provider-account-choice.ts` is now the one rule for which
account a turn runs on, and his instruction there was "never wait for a refill while another
account has room."

That narrows what banking is *for*, and the narrowing is worth stating plainly because it
would otherwise be designed around a problem that no longer exists. **Banked work is not a way
to survive exhaustion — account choice already handles that. It is a way to spend an allowance
that would otherwise reach its reset unused.** Which is what he asked for on 2026-09-16:

> "we should be able to like … capture those things before they get wasted"

and again in the same message:

> "I was to waste a lot of my usage previously i was not even using all of my token things …
> never let go any of those like basis sessions"

### Three things `concierge:3633` corrected, which this design now rests on

Reviewed with that session on 2026-09-23 (request `b83bfe85`), because half of what banking
needs is theirs.

1. **A conversation cannot move between accounts yet.** The move branch was removed from
   `provider-account-choice.ts` in `709adad` this evening: a conversation runs on its own
   account or waits, and only a brand-new conversation gets a choice. The shared-history fix
   is expected to reverse that, its decisive half is proven, and the continuation proof was
   still running at the time of writing. **Nothing below depends on movement**, and everything
   below gets better for free if it lands.
2. **"Use it before it lapses" already exists, for a different thing.**
   `bot/src/provider-reset-policy.ts` spends a Codex **reset credit** when work has genuinely
   stopped with nowhere to go. It is shipped, it is not rebuilt here, and it does not overlap:
   it spends a *credit* to unblock work that already exists, while banking spends *allowance*
   on work nobody was waiting for. Only Codex grants reset credits at all, so that mechanism
   has no Claude counterpart — but ordinary allowance, which is what banking spends, exists on
   both, so banking stays provider-neutral where the reset policy cannot be.
3. **Banked work must never become the reason real work waits.** Their invariant is that
   nothing waits for a refill while another account has room; banked work that spends that
   room inverts it, and he meets a wall at 9am that his own work did not create. The reserve
   below is their requirement, placed here because it belongs to the spender.

## The one idea

Everything that waits is the same thing: **a request that has been recorded but not yet
admitted, plus a rule that decides when it is.** Scheduled, banked, and the
wait-for-other-work that already exists are three *rules*, not three subsystems.

This is not a new store. `session_communication_requests` already holds recorded requests
whose `payload_json` carries `after`, and `SessionCommunication.dispatch` already returns
early — leaving the request unadmitted — while a prerequisite is unmet
(`bot/src/session-communication.ts:909`, `:925`). Extending that is the whole build:

| Rule | Waits for | Exists today |
| --- | --- | --- |
| `after` | named executions finishing | **yes** — `afterRequestIds` |
| `at` | a time, once or repeating | no |
| `banked` | an allowance about to expire unused, with nobody waiting | no |

Every rule ends the same way: the request is admitted exactly as if it had just been asked,
through the same `sessions ask` path, with the same request id as its idempotency key. That
path already starts a session in **any registered project** with any provider, which is his
requirement from 2026-09-16:

> "that infrastructure should support starting sessions, starting agents for whichever
> project. Any project in my workspace not just a thinkering."

And it is the extension he pointed at himself:

> "We already have some sort of design for queuing up requests so the inbox router can queue
> up request behind completion of different other sessions to kind of unify and extend the
> system here and build a unified system"

## States, and what ends each wait

```
                    ┌──────────── he cancels ──────────────┐
                    │                                      ▼
  saved ──▶ waiting ──▶ releasing ──▶ running ──▶ done   dropped
              │  ▲          │            │
              │  └──────────┘            │   provider refusal / boundary reached
              │   not yet / yielded      └──────────────┐
              │                                         │
              └◀────────────── returns to waiting ──────┘
                     (banked only; scheduled reports a miss)
```

| State | Meaning | What ends it |
| --- | --- | --- |
| `waiting` | recorded, nothing running | its rule is satisfied; **or** he starts it now; **or** he cancels; **or** it expires |
| `releasing` | the decision is made, the input is being accepted | the same transaction that records the accepted input — so a crash between deciding and accepting leaves it `waiting`, never half-started |
| `running` | an ordinary turn, indistinguishable from any other | the turn ends |
| `done` / `dropped` / `missed` | terminal | — |

**Nothing in `waiting` or `releasing` holds a turn open.** That is the property the whole
design exists for.

### The signals

There are exactly two, and neither is new machinery:

1. **Execution change** — already drives `dispatch` for every open request. This is what
   releases an `after` rule, and the only thing that does.
2. **A tick** — a plain interval inside the Concierge process, beside the ones already at
   `bot/src/index.ts:3872-3892`, that re-runs the rules for every `waiting` row. A time-based
   rule has no execution change to ride on, so it needs this. One pass over a handful of rows;
   no provider call, no process.

**Why a tick inside the service rather than a systemd timer.** The global rule sends scheduled
work to the native supervisor, and the supervisor *is* already running this: Concierge is a
systemd unit. A separate timer poking the service would be a second owner of the same
decision, which is the failure mode that rule exists to prevent. The `Persistent=true`
property — a firing that was missed while down happens on the next start — is supplied here by
**catch-up**: the tick runs once at startup, so anything whose time passed while Concierge was
restarting is due immediately. The honest cost: **if Concierge is down, nothing fires.** That
is equally true of any design, because Concierge is what starts work.

## The banked rule

One sentence: **release when an allowance will reach its reset unspent and nobody is expected
to want it first.**

The four conditions below are that sentence's evidence, not four independent settings. All
must hold; each cites why.

| Condition | Why it is there | Value |
| --- | --- | --- |
| A window resets soon and the forecast says it will arrive with headroom unspent | this is the waste banking exists to prevent; the forecast and its basis already exist | reset within **2 h** — "start looking at two hours early" |
| At least a floor of time remains before that reset | "it should obviously not be triggered at the end of this session if the session limit is going to expire in 30 minutes … 30 minutes might not be enough time" | **≥ 1 h** remaining |
| Nothing is executing and nothing of his is queued | "there's no active sessions running" | fleet-wide, across the Mac peer too |
| The local hour is inside the quiet band | this is what makes the condition above *mean* something | **00:00–06:00** by default — his to set |
| The allowance is above the reserve, and stays above it | banked work may never be the reason his own work waits | stop at **25 %** headroom remaining |

That last row is the one I had backwards in the original conversation, and he corrected it.
The correction is the load-bearing idea, so it is quoted rather than paraphrased:

> "In the time of the day it's actually reliable because you can confidently say if usage is
> gonna expire in three hours at 3 a.m. and there's no active sessions you can confidently say
> that oh there is not going to be any more active sessions and I can like an access to do
> this right now right versus 3 p.m. you cannot say that because I can come back and I can ask
> ask you to like do something and then I should not be shocked that we are actually like
> consumed all of our little capacity here."

Zero active sessions at 3pm predicts nothing, because he can walk back in. At 3am it predicts
the rest of the window. **The clock is not a tiebreaker on top of idleness; it is what makes
idleness evidence.**

**None of the four numbers is derived.** Two come from his own words, two are guesses with no
measurement behind them. They are named constants with their reasons beside them, and the
quiet band and the reserve are questions for him below rather than defaults to discover later.

### The reserve, and why banking stops short of the wall

Banking spends what would be wasted. It must never spend what he would have used. So a banked
run stops while a quarter of the window is still unspent, and the reserve is checked
continuously rather than only at release — a run that eats into it ends there and returns to
`waiting`.

The reserve is also what keeps banking from lying to him through two mechanisms that already
watch the same numbers, and a mark on the turn is what makes that reliable rather than
hopeful. **A banked turn is labelled as banked**, and two existing consumers read that label:

- **The automatic reset policy** (`provider-reset-policy.ts`) fires when work has really
  stopped with nowhere to go. Banked work that exhausted an account at 3am and then stopped
  would satisfy that test and could spend a scarce Codex reset credit for work nobody was
  waiting on. Banked turns are excluded from that branch. This is `concierge:3633`'s guard and
  it protects the scarcest thing either design touches.
- **The hour-ahead "running low" warning** reads recent pace over a trailing hour, so a 3am
  burst looks exactly like him burning fast, and he would be told he is running low about work
  he never started. The reserve should keep banked spending under the threshold on its own;
  the label is what makes that a guarantee rather than an expectation.

### Duration is not a gate

> "the router agent can estimate but like sometimes these estimates are not that right so I
> don't think we should you know we can keep it but we should like not rely on that too much."

So an estimate is kept, shown to him, and used to order the queue — never to decide whether
something may start. What replaces it as a safety property is a requirement on the work
itself: **banked work must be safe to be cut off.**

That is already true of how a turn dies at a limit: it fails with the provider's own refusal
carrying its reset instant, and returns to its queue under every existing effect-safety check
([accounts plan](2026-09-23-accounts-share-one-history.md), "Mid-turn exhaustion needs no new
machinery"). A banked item that is cut off returns to `waiting` and takes the next
opportunity.

**Its next opportunity is on the same account, until movement lands.** A conversation is
pinned to the account it started on (correction 1 above), so a resumed banked item waits for
*its own* account's next unspent window rather than taking room elsewhere. That makes banked
work slower to finish than it will be later; it does not make it wrong, and nothing here has
to change when movement arrives.

One rule follows from his intent and is worth making explicit: **a banked run ends at the
boundary it was spending against.** The point was to spend an allowance before it expires, not
to start eating the fresh one at the reset, so when that window resets the session is stopped
— cleanly, resumable, back to `waiting`. Work that cannot tolerate being stopped that way
should be *scheduled*, not banked. That is the real difference between the two for whoever is
choosing, and it should be the first line of the guidance an agent reads.

### One at a time, and deployments come first

Both fall out rather than being added:

- While banked work runs, a session is executing, so the third condition is false and nothing
  else is released. **Serial by construction.**
- **When a deployment is waiting, nothing new is released, and a banked turn already running
  yields.** Releasing nothing is not enough on its own: a single banked turn started at 00:30
  can hold a release for hours, and a waiting update he cannot explain has already cost him
  two evenings. Because banked work is required to be safe to cut off, yielding is the
  behaviour it already has — the session is stopped, resumable, and returns to `waiting`.
  Scheduled work does not yield: he named its time, so the deploy waits for it as for any
  ordinary turn.

This is the direct answer to "without waiting on a background thing that blocks all of the
deployments": **waiting costs a deployment nothing, and running yields to one.**

One environmental note from `concierge:3633`: the Mac peer may simply be asleep at these
hours. An unreachable peer is an ordinary condition for this scheduler — fewer places to run —
and never a failure to report.

## What is banked, and what is scheduled

- **Scheduled** — a time he or an agent named. May repeat (nightly, weekly). Each firing is
  its own request; a firing whose predecessor is still `waiting` or `running` is **skipped and
  said so**, never stacked. A scheduled item may carry an expiry, after which it is `missed`
  rather than run late — "test the 5:15pm refill" is worthless at 9am the next day.
- **Banked** — no time at all. "Bank it" is the verb he chose, with his reason:

> "I will also use bank. I think bank it is also pretty cute. because we are still banking on
> it by making use of it right?"

## What he sees

Checked against the `interface-decisions` skill; the rule numbers are its.

A saved item appears in the sessions list as a row that exists before it runs — his own
request from 2026-09-16:

> "we can add like a scheduled session a session bar which is scheduled and I can those gives
> me a good like look at all the different things that are scheduled and like you know when
> they might start acting on and if I want to I can like start just say here let's start with
> the minute right now."

- **Named by what it will do**, with its project, and its destination named before it runs
  (D6, D7): *"Fix the resurrection bug · thinkering · banked"*, never an id.
- **Why it is waiting, in one line, in the working and the broken case differently** (D7):
  *"Tonight, if Claude's weekly allowance is still unspent"* · *"At 5:15pm"* · *"After the
  release finishes"* · and, when it cannot: *"No window found in 6 days"*.
- **Controls are marks with tooltips, never words** (D1, D2): `Play` to start it now, `Clock`
  to change when, `Trash2` to drop it. One accent, on nothing here — the primary action on
  this row is reading it — and the destructive mark is not adjacent to `Play` (D8).
- **Dropping it destroys it** (D5) and shows the notice that carries its own undo, with the
  countdown drawn on the control, five seconds minimum (D4, D10).
- **A banked item that has found no window** is a decision, so it reaches his attention list
  through the existing needs-you path — with run it / reschedule it / drop it — and not before
  then, because everything up to that point is something the system is handling (D11).
- **Nothing interrupts him when banked work runs or is cut off** (D11). It appears in history
  like any other session; a session that was stopped at a boundary says so in its own row.

## Who owns what

| Part | Project | Why |
| --- | --- | --- |
| The saved-work rows, the rules, the tick, catch-up, admission | **slack-concierge** | it already owns requests, admission, projects, account choice and usage; a second owner of "when does work start" is the thing to avoid |
| `sessions bank` / `sessions schedule` / listing / start now / cancel | **slack-concierge** | same surface agents already use to ask |
| The list he reads, and its controls | **thinkering** | his words: "Concierge should own the observer of the spare queue and the thinker can just own the surface where we see this information" |
| Which account a released turn runs on | **concierge:3633's work** | this design never chooses an account; it asks for a turn and lets that rule place it |
| Spending a Codex reset credit to unblock stopped work | **`provider-reset-policy.ts`** | shipped; banked turns are excluded from its "work has really stopped" branch |
| Headroom, forecasts, where the room is | **the usage forecast** | read through `sessions usage`; no second reading of provider limits |
| A new timer or unit | **nobody** | none is needed |

## Open, and his to decide

1. **The quiet band.** 00:00–06:00 local is a guess. Getting it wrong in the permissive
   direction means waking up to spent capacity.
2. **The reserve.** A quarter of the window is a guess too, and it is the dial between "banked
   work finishes things" and "banked work is never in his way". It can be measured later
   against how often he actually arrives at a window banking had touched.
3. **What a banked run is allowed to do unattended.** It runs at 3am with nobody watching. Does
   a banked "fix this bug" commit, push and deploy through the normal path, or stop at a pushed
   branch for the morning? This was asked on 2026-09-16 and not answered; it is the one
   question in this design whose answer changes what gets built rather than a constant.
4. **Whether an unspent allowance is worth spending at all on a given night.** The design will
   happily fill a quiet window with low-value work. The guidance for what is worth banking is
   his, not the scheduler's.
