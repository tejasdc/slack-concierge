# Pause all agent sessions

## Focus hold

Focus hold is a separate cloud-owned lease for the Inbox project router only. While
`now < untilMs`, new router turns remain accepted and queued; other sessions start
normally, and no running turn is stopped. The router is identified by native metadata
`inboxRole: project-router`, the same role Pause all exempts. Captures and agent
requests retain their existing intake and order except for the human capture review
described below.

`GET /sessions/v1/focus-hold` reports the effective lease and the current count of
queued router turns. `POST /sessions/v1/focus-hold` sets or renews it with `held: true`,
`untilMs`, `label`, and a stable `clientActionId`, or clears it with `held: false` and
the action ID. Capture review is off by default at the accepting owner. It can be
re-enabled later by setting `CONCIERGE_FOCUS_CAPTURE_REVIEW_ENABLED=1` on **both**
cloud and Mac owners and installing/restarting them. Until then, older clients may
continue sending `reviewCaptures: true` or `holdForReview: true`; the owner accepts
each capture and routes it normally. The Focus lease still holds router turns.
Once owner review is enabled, a Focus client adds `reviewCaptures: true` to **each**
start and renewal to opt in. Without that client opt-in, the lease remains queue-only.
`GET` reports the effective `reviewCaptures` flag. Each expiry must be in the next 15 minutes; Thinkering renews while
focus continues. Repeating an action ID cannot change its meaning. Renewals preserve
`since` while the prior lease remains live. The claim checks the deadline itself, and
the queue timer wakes at expiry; clearing wakes it immediately. A Mac owner forwards
these controls to the cloud. This does not change Pause all or interrupt running work.

### Focus capture review

When owner review is enabled, the accepting owner retains the words, attachment custody IDs, immutable source identity and
hold decision in one SQLite transaction. An ordinary human Inbox capture received while
the Focus lease is live **and** its current action enabled capture review has no turn or
provider steering. A Capture bar reply whose stable
action starts `share-reply:` is held in its addressed session with its resolved reply target.
For a Mac-owned target, Thinkering supplies `holdForReview: true` with that addressed
reply at capture time, and the Mac owner retains it locally; its owner does not have a
cloud Focus lease. This flag is accepted only for a human Capture bar reply.
The legacy Thinkering capture gateway also accepts `holdForReview: true` with the
capture. It persists that explicit Focus-at-capture decision in its source snapshot and
forwards it to native admission, so a delayed gateway delivery remains held even after
the lease expires. Native Thinkering Inbox capture admission accepts the same flag.
Urgency wins when both flags are set. An exact duplicate only reads the same retained
input. Neither a lease expiry nor a clear
releases any of these captures. Captures accepted before this change are untouched.

The held Inbox capture event is recorded only at selected release, so normal Inbox pages
and deltas do not show the capture before review. `GET /sessions/v1/focus-hold` includes
`heldCaptureCount` even after the lease expires. A Mac owner's direct status read adds
`localHeldCaptureCount`; its held page is its own `GET /sessions/v1/presentation/captures?heldOnly=true`.
Thinkering's federated surface must read both owners and route each selected release to
the owner that retains those captures. A Mac owner checks the cloud Focus lease before
accepting a release. If the Mac sleeps, its held items remain there for later review.
`GET /sessions/v1/presentation/captures?heldOnly=true` pages the pending captures newest
first. Each item includes its accepted `id`, release `captureId`, `sessionId`, bounded words,
source, attachment count and `held: true`. An ordinary Inbox capture's full words and
attachment metadata are at `GET /sessions/v1/inbox/<captureId>`; an addressed reply's
full retained request and target are at `GET /sessions/v1/operations/<id>`.

After Focus ends, the person may select one to 100 capture IDs and call
`POST /sessions/v1/focus-hold/release` with `captureIds` and a stable `clientActionId`.
The retaining owner refuses release while the cloud lease is live. It moves the exact selected
ordinary captures into the canonical Inbox router queue in one transaction, preserving
each input and attachment identity. An addressed reply retains its resolved recipient;
its forwarding intent is committed before forwarding and is reconciled after restart.
The action ID retains the ordered selection. A duplicate returns the prior result;
reusing the ID for another selection conflicts. Releasing a capture already released
by another action conflicts rather than replaying it. If he selects many captures,
the router receives them as ordered turns after this one chosen release action.

An explicit `urgency` on `POST /sessions/v1/inbox` or the legacy Thinkering capture
gateway can be `data-loss` or `medication`. The gateway keeps this choice in its
durable source snapshot before forwarding the capture to native admission.
These captures are retained with that reason and enter the router during Focus at higher
queue priority than ordinary held router turns. The owner does not infer urgency from
capture text or gesture. Existing running work is never interrupted. The authenticated
Thinkering producer must expose the reason as a user choice and pass it unchanged.
An addressed Capture bar reply has no implicit urgency: it follows the capture hold,
while an ordinary typed conversation reply remains live. The two paths stay visibly
distinct in the product.

The owner switch, 15-minute lease and explicit review opt-in are the admission signal for *new* captures.
If Thinkering does not renew it, later captures use ordinary intake; already held captures
remain held for review. When capture review is deliberately re-enabled, Thinkering
must renew the lease with `reviewCaptures: true` while Focus continues. The status and review page
come from the owner ledger, so a stale page cannot silently release an unselected item.

State card: the cloud owner writes the capture and release order; `source.kind` plus
`source.id` identify Inbox retries, and the Capture bar action ID identifies addressed
retries. An acceptance receipt proves durable custody, a released receipt proves queue
admission, and neither proves provider completion. A crash after release but before a
provider acknowledgement leaves the exact existing queue or forwarding intent for its
normal reconciliation; it never creates a second capture. The Mac and older Thinkering
clients may omit urgency. Clients that omit `reviewCaptures` retain queue-only Focus
behavior until the review screen is available. The
falsifying sequence is accept under Focus, lose the response, retry, expire the lease,
read the same held item, then release the same action twice: one provider input results.

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
The cloud keeps the last successful peer snapshot and its observation time separately
from the latest attempt. A failed background check retains that snapshot and marks the
peer unreachable; the status read never contacts a peer. The response includes the
last reached time and its age, so a sleeping Mac can be shown as not reached since
that time without presenting the old snapshot as current. The existing five-second
reconciliation and peer contact refresh the record.

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
