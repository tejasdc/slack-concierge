---
title: "Durable per-session turn queue"
type: implementation
status: implemented
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

## State transitions

```text
Slack input claim: pending -> turn

Turn:
  queued --atomic session claim--> running -> delivering -> done
                                     |            |-> delivery_parked
                                     |-> error
                                     |-> interrupted after dead-owner recovery

Session:
  available --claim oldest queued--> running --terminal settlement--> idle/error
```

Session availability is proved by the absence of another `running` or
`delivering` turn, not solely by the cached session status. Claim repairs that
status transactionally, closing the legacy crash gap where a terminal turn and
`sessions.status='running'` could disagree.

`cancelled` remains valid for explicit lifecycle cancellation, but contention
must not produce it.

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

Add one guarded state transition for every pre-delivery failure that atomically
terminates the running turn, queues its cleanup, and releases its session to
`error`. Use it for execution setup failure and the existing acquisition-hook
failure. This removes the current crash gap between `finishTurn` and
`setSessionStatus` before a queued successor depends on the release.

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
session-lock transaction requires no queued, running, or delivering row for the
session, independently of the cached session status. The wake remains pending
until ordinary FIFO work drains.

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
- Generalizing comparison/prebuilt turns into queued execution; their forced
  fresh session remains immediate and uncontended.

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
14. comparison turns remain immediately executed on forced fresh sessions;
15. two rapid Pebble-style messages both reach provider execution;
16. deployment-verification wakes cannot overtake queued input or use stale
    `idle` state to create a concurrent owner;
17. archiving a session terminalizes accepted queued input visibly while
    preserving the archived session, skipping provider admission, and never
    exposing a restart-recoverable live owner; its status and reaction cleanup
    remain runnable in the current process as well as after restart.

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
