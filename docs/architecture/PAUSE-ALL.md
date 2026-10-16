# Pause all agent sessions

## Focus hold

Focus hold is a separate cloud-owned lease for the Inbox project router only. While
`now < untilMs`, new router turns remain accepted and queued; other sessions start
normally, and no running turn is stopped. The router is identified by native metadata
`inboxRole: project-router`, the same role Pause all exempts. Captures and agent
requests retain their existing intake and order.

`GET /sessions/v1/focus-hold` reports the effective lease and the current count of
queued router turns. `POST /sessions/v1/focus-hold` sets or renews it with `held: true`,
`untilMs`, `label`, and a stable `clientActionId`, or clears it with `held: false` and
the action ID. Each expiry must be in the next 15 minutes; Thinkering renews while
focus continues. Repeating an action ID cannot change its meaning. Renewals preserve
`since` while the prior lease remains live. The claim checks the deadline itself, and
the queue timer wakes at expiry; clearing wakes it immediately. A Mac owner forwards
these controls to the cloud. This does not change Pause all or interrupt running work.

Concierge owns the pause. The cloud owner's SQLite ledger holds one generation and one
admission gate. The native and legacy queue claims consult that gate in their claim
transaction, so new messages, agent requests, scheduled turns and watch firings can be
retained but cannot start a provider turn. The Inbox project router is the one exception:
it remains answerable and can call `router-actions.sh sessions pause status|all|resume`.
Its new child requests and its own scheduled turns are still held by the gate. Watch
polling and command launch also wait while their session is held. An optional schedule
expiry keeps its original meaning: if its window ended during the pause, it expires
when that session resumes.

`POST /sessions/v1/pause-all` records the gate and the exact running turns in one
transaction. It marks Stop intent for each eligible run, then asks the execution host to
interrupt it. The host waits until tracked provider tools have reported completion
before issuing the provider's native interrupt. The status distinguishes requested,
confirmed stopped, unconfirmed and ChatGPT still thinking. A stalled tool can delay the
interrupt; native provider reports cannot prove an external side effect is fully rolled
back. A ChatGPT request already thinking has no native Stop and may finish while paused.

The cloud sends the generation to each peer. A Mac that sleeps retains its local gate;
on startup it reads the cloud state before adopting or claiming work. If that read is
unavailable, it holds claims until the cloud sends a confirmed state. The cloud status
reports a peer as pending until it acknowledges the current generation. A peer response
includes its bounded paused-work snapshot, so thnkr.ing can show both machines.
While paused, the existing reconciliation refreshes that snapshot after acknowledgement,
so a confirmed stop replaces the initial pending stop in the sheet.

`POST /sessions/v1/pause-all/resume` with only an action ID clears the gate on both
machines. With `sessionIds`, it keeps the global gate and admits only those sessions.
Queued work in an admitted session uses its normal queue order. A new Pause all action
clears those selected exceptions and holds every eligible session again. Retrying the
same action keeps its original meaning. Named database bindings keep the action identity,
pause flag and generation separate when recording each control.
For each stopped run,
Concierge adds one service continuation that tells the agent to inspect retained work
and current files before continuing, rather than replaying an input whose side effects
may have occurred. A stable action ID makes a retry the same control. Existing session
level suspension still applies, and a stopped session with an unresolved provider
outcome still requires inspection.
If a long tool finishes only after Resume was pressed, the pending Stop may settle late.
The owner's regular reconciliation admits that run's checked continuation then, while
the same stable input identity prevents a second continuation after a retry or restart.

The product entrance is the shared thnkr.ing header's Pause all agents control. It
posts through the authenticated Thinkering command entrance to the cloud owner. The
paused sheet shows running and queued sessions, peer acknowledgements and selected or
all resume. It never calls a provider directly.

Pause all governs Concierge session admission and the providers' running turns. It does
not stop arbitrary processes or independent tools started outside Concierge, nor the run of an
outside request (`sessions ask --outside`), which is outside Concierge by design; Stop on that
session still ends it, and its next turn waits for the pause like any other. If a
provider has detached background work, its own lifecycle and the running session's
record remain the source of truth; the pause status must not label that work stopped.

## October 14, 2026: acceptance pauses on the live system

The agents that cancelled at 12:27 PM ET on October 14 were not cut off by that day's Concierge
restarts (every running run was taken back at 12:20 and 12:26 PM). They were stopped by Pause all
generation 1, action `pause-acceptance-6337-20261014`: the agent building this control ran its
acceptance check against production, which stopped seven running turns including its own. Later
generations (`outside-…`) were the same check repeated from outside Concierge. Check this control
on a separate instance, never on the live owner.
