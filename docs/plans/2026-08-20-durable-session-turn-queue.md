---
title: "Durable per-session turn queue"
type: implementation
status: implementation-in-progress
date: 2026-08-20
---

# Durable per-session turn queue

## Outcome

When a Slack input resolves to a provider session that already owns a live
turn, Concierge durably queues the new turn instead of cancelling it. Queued
turns receive one durable row, at most one live local owner, and FIFO promotion
after the session becomes available. The originating Slack thread receives a
durable queued status and needs no manual resend. Once promoted, the existing
provider-boundary ambiguity and interruption rules continue to apply.

This closes the 2026-08-20 Pebble incident in `#slack-inbox`, where two distinct
top-level Slack messages shared the channel's `single-persistent` provider
session and the second was cancelled by the session lock.

The 2026-08-24 extension closes the same loss invariant at the provider
boundary. An accepted Slack turn that cannot dispatch does not become an
unresumable terminal error: a recognized transient provider rejection returns
the same durable turn to its session FIFO with persisted backoff, while an
entitlement, authentication, unknown terminal, setup, or ambiguous failure
parks the turn durably. Ambiguous attempts remain visible but cannot be blindly
resumed. The existing queue remains the only scheduler.

## Operating profile

Concierge is a single-service, SQLite-backed personal bot. It may run many
provider sessions concurrently, but each provider session must serialize its
own turns. Queue depth is normally small; correctness across crashes and deploys
matters more than high-throughput scheduling. The existing SQLite database,
process identity, turn recovery, and Slack status projection are sufficient;
no new service, credential, workflow framework, or queue database is needed.

## Root cause

`acquireSessionTurn` already creates a durable `queued` turn before attempting
the session lock. When the session is `running`, it immediately rewrites that
turn to `cancelled`. `handleUserMessage` then posts a resend instruction. A
`single-persistent` channel intentionally maps distinct visible Slack roots to
one provider session, so the provider-session lock is correct; terminal
cancellation on ordinary contention is not.

## Invariants

1. `session_id` is the ordering and concurrency key. At most one `running` or
   `delivering` turn may own a session.
2. Every accepted provider input has one durable turn before the handler
   returns. Contention leaves that turn `queued`; it never asks the user to
   resend. The queued status projection intent is committed in that same
   transaction.
3. Queue order is the database admission sequence (`turns.id`). A new arrival
   cannot bypass an older queued turn in the same session.
4. Different sessions remain independently runnable.
5. Dequeue and deployment-drain claim are mutually exclusive SQLite
   transactions. A queued turn never starts while `deployment_drain` exists.
   Inputs first observed after the gate wins retain the existing `draining`
   classification and create no turn.
6. Queued turns are ownerless. `running` and `delivering` turns retain the
   existing exact process-identity ownership and recovery rules.
7. A promoted turn is never blindly replayed after an ambiguous provider
   boundary. Existing interrupted/delivery recovery runs before later queued
   work.
8. Visible status is a durable projection owned by the queued turn's original
   Slack reply thread. Its desired revision advances monotonically from queued
   to working to a terminal state.
9. Queued content has no automatic TTL. Age is context, not permission to drop
   accepted input.
10. Same-visible-thread live input remains steering. This change only replaces
    provider-session busy cancellation.
11. A failed provider dispatch never deletes or terminalizes an accepted Slack
    input. Recognized retry-safe 429, 5xx, rate-limit, overloaded, and temporary
    provider rejections return the same turn to `queued`; entitlement,
    authentication, and other certain pre-tool terminal rejections become
    `parked` and resumable.
12. Retry classification is explicit provider-boundary data, not a generic
    catch-all retry. This extension ends when the adapter observes tool or
    artifact activity: a transient-looking result after that boundary retains
    the existing interrupted/ambiguous non-replay lifecycle.
13. A queued retry or parked predecessor blocks later turns in the same
    session. Other sessions remain runnable. Neither retries nor parked turns
    have an automatic age cutoff.

## State transitions

```text
Slack input claim: pending -> turn

Turn:
  queued --atomic session claim--> running -> delivering -> done
                                     |            |-> delivery_parked
                                     |-> queued after retry-safe provider failure
                                     |-> parked after certain pre-tool terminal/setup failure
                                     |-> existing error/interruption after execution begins

Session:
  available --claim oldest queued--> running --settlement--> idle/error
```

Session availability is proved by the absence of another `running` or
`delivering` turn, not solely by the cached session status. Claim repairs that
status transactionally, closing the legacy crash gap where a terminal turn and
`sessions.status='running'` could disagree.

`cancelled` remains valid for explicit lifecycle cancellation, but contention
must not produce it.

### 2026-08-24 incident evidence

Production state confirms the two new provider failures were accepted and then
made unresumable by the same generic catch path:

- turn `390`, Slack input `1787545232.697419`, reached
  `provider_started_at` and ended `error` with the exact disabled-subscription
  message;
- turn `419`, Slack input `1787555393.054739`, reached
  `provider_started_at` and ended `error` with the exact `529 Overloaded`
  message;
- turns `379`, `381`, and `382` are the three 2026-08-22 Pebble inputs and all
  ended `cancelled` with `Session is already running another provider turn.`

The Slack input claims and raw turn text still exist, but neither terminal
state has an execution path. Historical rows are not replayed automatically
because Tejas already retried the two substantive inputs and the Pebble
fragments are stale.

## Design

### 1. Split durable admission from execution ownership

Refactor session turn admission into one transaction that:

1. preserves the existing deployment-gate check: if the gate already exists,
   classify the input as `draining`, create no turn, and retain the durable
   recovery notice;
2. otherwise finalizes the existing Slack input claim as `kind='turn'`;
3. inserts the turn in `queued` with its visible reply thread;
4. returns `duplicate` for an existing input;
5. promotes it only if the session has no live turn and it is the oldest queued
   turn for that session;
6. when it cannot promote, seeds the existing turn-status desired text,
   revision, and `projection_status='pending'` in this same transaction.

The result becomes `acquired`, `queued`, `duplicate`, or `draining`. `draining`
always means no turn was admitted. Busy is no longer a terminal result.

No queue table or generic serialized handler envelope is needed. A claim joins
the existing durable authorities:

- `turns`: turn ID/order, session ID, message timestamp, visible reply thread,
  and raw text;
- `slack_user_input_claims`: channel, user ID, raw text, and strictly decoded
  `SlackMessageFile[]`;
- `sessions`: provider, current provider UUID, and session thread key;
- `channels`: current project paths, additional directories, and channel
  configuration.

The queued contention path is always an ordinary Slack-input turn on an
already-reserved session. Comparison turns set `forceNewSession=true` and
therefore create a fresh uncontended session. The session remains authoritative
for the bound provider and provider UUID. The admitted turn persists the
selected model and reasoning effort so a queued restart does not silently fall
back to a newer provider default. It re-derives ordinary mention stripping,
link hydration, and skill selection from persisted raw text, while project
paths and skill/config content are intentionally current at execution time. A
missing user, malformed file envelope, missing channel, archived session, or
any violation of these assumptions atomically terminates the claimed turn with
a visible error; it is never guessed from an old Slack event.

When a queued turn is promoted, reload the current session row so it sees a
provider UUID bound by the preceding turn.

### 2. Add one coalesced queue coordinator

A focused process-local queue coordinator owns wakeups and claims all currently
runnable sessions without awaiting one session before starting another. The
coordinator is not durable; SQLite rows are. Its authoritative claim operation
is a transaction:

- reject while the deployment gate exists;
- select the oldest `queued` turn for one available session;
- ensure no earlier queued turn exists for that session;
- when the selected session is archived, atomically terminalize the queued row
  with durable error-projection and cleanup intent, then continue scanning
  without assigning a live owner; startup and the existing 60-second
  maintenance scan project both pending intents without requiring another
  restart;
- otherwise change the executable session to `running`;
- change the turn to `running` with the current instance owner;
- return the validated joined durable input described above.

An in-process keyed single-flight map prevents duplicate local workers, while
the database transition remains the correctness boundary. Every wake and claim
entry point also fails closed while the process-local `draining` flag is set.
Once a database claim succeeds, its execution must be registered synchronously
with `runClaimedTurn` so `activeTurnCount` advances before control returns to the
event loop. Wake the coordinator after admission, after terminal
settlement/recovery, at startup, and from the existing 60-second maintenance
loop so an out-of-process deployment-gate release cannot strand work.

Extract the current acquisition-to-execution owner boundary into one reusable
`runClaimedTurn` adapter backed by `ActiveTurnDispatchRegistry`. Both immediate
admission and later dequeue use it. It owns the existing `activeTurnCount` drain
accounting, visible-thread steering registration/closure, provider/runtime
service assembly, and the call to `executeAgentTurn`. The queue coordinator owns
only claim, wakeup, and local single-flight tracking; it must not duplicate
provider, delivery, status, artifact, or cleanup lifecycle code. Startup and
comparison dispatch likewise use the dependency-injected production seams in
`bot/src/turn-dispatch-seams.ts`, so their ordering and forced-fresh behavior are
tested without loading Slack Bolt.

Keep every pre-delivery failure settlement behind a guarded state transition
that atomically changes the running turn and releases its session. Use it for
execution setup failure and the existing acquisition-hook failure. This
removes the current crash gap between `finishTurn` and `setSessionStatus`
before a queued successor depends on the release; the 2026-08-24 extension
below changes the failure destination from unresumable `error` to retry or
park for accepted Slack turns.

### 2a. Extend the same queue across dispatch failure

Replace that terminal pre-tool dispatch settlement for ordinary Slack and
comparison turns with two guarded SQLite transitions. Both require the exact
running owner and durable attempt epoch, clear live ownership, release the
session, advance the durable status projection, and preserve the existing turn
ID, Slack input claim, raw text/files, selected provider/model, reply thread,
and FIFO position:

- **retry:** `running -> queued`, persist the failure class and absolute
  `dispatch_next_attempt_ms`, and leave `ended_at` unset;
- **park:** `running -> parked`, persist the failure class, clear the retry
  deadline, and leave the row eligible for an explicit guarded resume to
  `queued`.

Add only three fields to `turns`: monotonically increasing
`dispatch_attempt`, `dispatch_failure_class`, and
`dispatch_next_attempt_ms`. Reuse `agent_text` for the last failure text and
the existing `provider_admission_intended_at` for the current attempt. Do not
add another queue table, worker, serialized envelope, error column, or park
timestamp.

Every claim increments `dispatch_attempt`, clears attempt-local provider
admission/turn markers, and returns the epoch with the execution input.
Settlement and artifact reservation require turn ID, process owner, and epoch.
Provider client identity becomes
`slack-concierge:turn:<turn-id>:attempt:<epoch>` so a retry cannot be mistaken
for the prior terminal rejection and a stale attempt cannot settle the newer
owner.

`claimNextQueuedTurn` treats a retry row as runnable only when its persisted
deadline is due. Immediate admission, dequeue, and deployment-wake claim all
use the same predecessor predicate: an older `queued` row, including backoff,
or an older `parked` row blocks the session. Parked sessions remain ownerless
with cached status `idle`, so a deployment wake remains pending rather than
bypassing or parking the predecessor. The existing 60-second maintenance wake
executes due retries on its first subsequent pass; no per-turn timer is added.

Backoff is unbounded in attempt count and capped only in delay: 15 seconds,
then exponential growth to a 30-minute interval. There is no attempt limit and
no TTL, so an extended outage delays input but cannot discard it.

Provider adapters emit one tagged failure envelope carrying classification,
terminal-versus-transport certainty, observed tool use, and any observed
provider thread/turn IDs:

- HTTP `429`, HTTP `5xx`, `rate_limit`, `overloaded`, and explicit temporary /
  unavailable results are `retryable` only when the adapter observed no tool
  use;
- disabled subscription, authentication, authorization, API-key, entitlement,
  billing, and permission failures are `parked_access`;
- an unknown but certain pre-tool provider terminal result is
  `parked_terminal`;
- a transient-looking result after tool use and an ambiguous transport/provider
  outcome retain the existing non-replay interruption/ambiguity lifecycle.

Before retry or resumable park, persist any compatible observed provider session/turn
identity. A first-turn failure may bind a previously empty session. A conflict
with an existing bound UUID, an unconfirmed post-admission result, or accepted
steering is mapping/replay ambiguity: park the input visibly as non-resumable
rather than overwriting session authority or reconstructing an incomplete
provider attempt. The exact
`529 Overloaded` incident is retried; the exact disabled Claude subscription
incident is parked. Untagged errors before admission are parked as `setup`;
untagged errors after admission are not guessed retryable. Explicit archive /
cancel policy remains terminal and is not a dispatch failure.

Artifact ownership stays turn-owned and one-batch-per-turn. Retry, certain
pre-tool park, pre-admission crash recovery, and manual resume share one guarded
attempt reset: it may retire and replace only an empty collecting artifact
reservation, clear the current attempt's admission/turn markers, and reset
ownership. Any observed tool, registered artifact, or staged regular file means
dispatch succeeded far enough that this extension no longer applies; use the
existing interrupted/ambiguous artifact abandonment and cleanup lifecycle
unchanged rather than automatically retrying or resuming the input.

Ordinary/comparison turns persist `provider_admission_intended_at`
immediately before the non-atomic provider call. Dead-owner recovery may safely
requeue a running turn only when no admission intent exists and its artifact
reservation is empty. Once admission may have occurred, existing
provider-ambiguity/interruption recovery remains authoritative and never
blindly replays. Deployment-verification wakes retain their deployment-owned
recovery path and do not enter the Slack-input retry queue.

Expose `bun run bot/scripts/session-turn-queue.ts resume --turn-id <id>` as the
narrow operator surface. Its idempotent transaction selects exactly one
ordinary/comparison `parked` turn, rejects an archived session or non-empty
artifact reservation, unsafe steering, or an ambiguous failure class, clears
attempt-local admission/turn markers, changes it to `queued`, advances the same
Slack status projection, and reports `resumed` or `already_queued`. It never
resumes an ambiguous executed attempt. The existing maintenance pump notices
the queue state; no Slack command, resend, or new worker is required.

Comparison inputs are part of the accepted-input invariant. Admission persists
`turn_kind='comparison'` and atomically associates its already-claimed request;
queued reconstruction uses the existing prebuilt input policy rather than
ordinary mention/link/skill processing. Its durable comparison request remains
nonterminal while the turn is retry-waiting or parked and is idempotently
settled by the turn's durable delivery transition, without waiting for startup
reconciliation.

### 3. Make queued state visible

When admission leaves a turn queued, its transaction seeds the existing
turn-status projection with:

```text
Status: queued - another turn is using this agent session; this will start automatically
```

Use the existing deterministic turn-status client message identity and retry /
park behavior. Slack delivery is scheduled only after the transaction commits.
When execution begins, update the same status message to the normal working
state. Because working requests a later desired revision, a slow queued
projection can never regress the status after execution begins. Failure to
deliver the queued acknowledgement leaves the turn queued; once promoted, the
ordinary initial-working-status prerequisite applies unchanged.

Extend the status formatter with a `queued` state. Do not display an exact queue
position unless every admission and completion also durably refreshes it.

Retry and park use the same durable turn-status projection:

```text
Status: queued - provider temporarily unavailable; input preserved and retrying automatically
Status: parked - provider access failed; input preserved as turn <id> until resumed
```

The transition commits desired text before Slack is called. A failed status
update is retried by the existing projection worker. Retry waiting retains the
working reaction; parking schedules its existing durable cleanup so the turn
does not look live.

### 4. Preserve restart and drain behavior

Startup order is:

1. recover dead-owner `running` and `delivering` turns;
2. recover durable status projections and cleanups;
3. verify the provider runtime is ready;
4. start the queue coordinator and scan ownerless `queued` turns.

Queued turns do not count as active work for deployment. The existing deploy
gate may be acquired while queued rows exist. Dequeue checks that same gate in
its claim transaction:

- dequeue wins first: deploy observes active work and waits;
- gate wins first: the turn remains queued through restart;
- gate release: periodic/wakeup scan resumes it.

The capture delivery gate continues to hold new Pebble posts upstream during
deploy. Inputs already admitted before the gate remain queued.

A deployment-verification wake is lower priority than accepted Slack input. Its
session-lock transaction requires no queued, parked, running, or delivering row
for the session, independently of the cached session status. Retry-waiting and
parked settlement both leave cached session status `idle`, so the wake remains
pending rather than being parked by the status check or bypassing the FIFO.

`drainAndStop` closes the process-local queue coordinator immediately after it
sets `draining=true`, before it waits for active turns. A predecessor finishing
during SIGTERM therefore cannot claim its queued successor. Already-owned work
remains in `activeTurnCount`; ownerless queued work survives for startup
recovery.

The ordinary Slack handler also rechecks process-local drain at its final
synchronous admission seam, after every upstream await and immediately before
`acquireSessionTurn`. That check and durable `draining` classification contain
no await, so SIGTERM cannot interleave between the final check and acquisition.

### 5. Treat staleness as context

Never expire queued input automatically. Queue age remains derivable from the
turn admission timestamp for logs and operator inspection. A future explicit
cancel action or stale-input product policy may terminate a queued turn
visibly, but it is outside this change.

Historical turns already cancelled by the old busy path are not automatically
replayed. The rollout reports them for explicit operator disposition because
old time-sensitive requests may no longer be safe to run.

## Non-goals

- Changing `#slack-inbox` from `single-persistent` to `per-thread`.
- Running concurrent turns inside one provider session.
- Replacing same-thread steering with queued turns.
- Automatically replaying interrupted or provider-ambiguous turns.
- Building queue administration, priorities, quotas, or automatic expiry.
- Changing the capture queue or adding capture-specific provider sessions.
- Changing comparison admission from a forced fresh session; only its
  post-admission provider-failure retention joins the existing queue.
- Automatically replaying the five historical incident rows. The two useful
  provider-error inputs were already resent and the three Pebble fragments are
  stale.
- Retrying Slack response delivery after provider success; its existing
  delivery-specific ambiguity and parking lifecycle remains authoritative.

## Verification

Focused state and lifecycle tests must prove:

1. a second contending turn remains queued rather than cancelled;
2. three turns receive one durable row, one live local owner at a time, and FIFO
   promotion; a later arrival cannot jump the queue;
3. different sessions can be claimed independently;
4. duplicate Slack events retain one claim and one turn;
5. two visible roots in one persistent session receive status and output in
   their own threads;
6. a concurrent first turn binds its provider UUID and the next queued turn
   reloads it;
7. persisted raw text/files reconstruct ordinary mention, link, and skill input
   after restart, while malformed joined input fails visibly;
8. queued rows survive restart and run only after prior-turn recovery;
9. deployment claim and dequeue cannot both win, post-gate input still creates
   no turn, and gate release resumes pre-gate queued work;
10. queued status intent is atomic with admission and becomes working then
    terminal without a late queued revision or heartbeat overwriting it;
11. pre-delivery failure atomically releases the session and wakes its FIFO;
12. queued-then-promoted input retains same-thread steering and graceful drain
    ownership;
13. SIGTERM with a running predecessor leaves its queued successor ownerless and
    unexecuted until restart;
14. comparison turns remain immediately admitted on forced fresh sessions and
    persist their distinct reconstruction policy if provider failure later
    requeues or parks them;
15. two rapid Pebble-style messages both reach provider execution;
16. deployment-verification wakes cannot overtake queued, retry-waiting, or
    parked input or use cached `idle` state to create a concurrent owner;
17. archiving a session terminalizes accepted queued input visibly while
    preserving the archived session, skipping provider admission, and never
    exposing a restart-recoverable live owner; its status and reaction cleanup
    remain runnable in the current process as well as after restart.
18. the exact `529 Overloaded` provider result requeues the same turn with a
    future durable deadline, preserves FIFO, and succeeds on a later attempt
    without creating another Slack input claim or turn;
19. the exact disabled-subscription result parks the same turn, visibly blocks
    its session successor, survives restart, and resumes through the guarded
    operator transition after access is repaired;
20. captured Claude/Codex adapter fixtures for `429`, every `5xx`, the exact
    overloaded and disabled-subscription incidents, entitlement/auth markers,
    unknown failures, and transient-looking failures after tool use traverse
    the production execution seam with structured identity/tool evidence;
21. a retry-wait predecessor cannot be claimed early or bypassed, while a due
    retry does not block runnable work in a different session;
22. a crash before provider admission safely requeues the turn with a new
    attempt epoch, while a crash after persisted admission intent retains the
    existing non-replay interruption/ambiguity behavior;
23. retry/park and session release are one transaction; a stale attempt cannot
    settle a newer epoch; an empty artifact reservation is replaced and its old
    staging tree cleaned, while tool/artifact activity bypasses this extension
    and retains the existing abandonment/cleanup lifecycle;
24. immediate Slack turns, later dequeued turns, and forced-fresh comparison
    dispatch all pass through the production execution seam; a comparison
    request remains nonterminal through retry/park, survives restart, and
    settles done exactly once after eventual delivery;
25. stopping the heartbeat awaits any in-flight update before retry/park intent
    is projected, so delayed heartbeats cannot regress visible status; a failed
    status projection recovers after restart, retry retains the working
    reaction, and park schedules durable reaction cleanup;
26. the local resume CLI is idempotent, rejects archived/non-empty/ambiguous
    turns, advances durable status intent, and needs neither Slack resend nor a
    second scheduler.

During iteration run only the focused state, routing, status, and turn-execution
tests. At the milestone run the full `cd bot && bun test` gate once, obtain an
independent review of the actual diff, and update current-state lifecycle and
provider-session documentation in the implementation commit.

## Rollout

No data rewrite is required for future turns because `queued` already exists.
Before deploy, report rows with the exact historical busy-cancellation
fingerprint. Deploy through `bot/scripts/deploy.sh`; queued rows admitted before
the gate must remain present and begin only after the new process is ready and
the exact gate token is released.
