# Account State Actor — one writer, one event stream, no stale consumers

Author: 2026-11-22, in response to Tejas's directive after the 2026-11-21 Codex-switch
and Claude-probe incidents: *"never face any issues regarding accounts or account
switching ever again."* Goal: 5-nines reliability for the account subsystem in the
single-operator operating profile (one person, two machines, low cardinality).

Supersedes the write-side gap left by PR #1019 (the account-authority rebuild, which
unified reads only). This plan is this skill's deliverable — a state card and the
falsifying checks for each known failure mode.

## Why this exists

PR #1019 collapsed roughly twelve read paths that answered "can this account take
work?" into one function (`canTakeWork`). It did **not** unify the **writes** that
populate the state `canTakeWork` reads. Those writes still happen in five places on
their own cadences, with no ordering guarantee between them and no event stream to
consumers. The 2026-11-21 Codex switch failure was the symptom: the operator switch
wrote `auth.json`, the runner's identity cache lagged for minutes, the probe cache
reflected the stale runner view, and `canTakeWork` correctly answered "no" for the
account the runner was still naming as current. The authority was right about a
stale world.

This plan closes that gap. One actor owns every write. Every write produces one
event with a monotonic revision. Every consumer either reads the actor's current
snapshot or subscribes to the event stream. Nobody else touches `auth.json`, the
runner's identity call, the readings cache, or the per-session binding in isolation.

## State card

### 1. Entity and single writer

**One actor, on the owner process (server).** The owner lives on the server; the
Mac is a peer. Codex only runs on the server. Claude runs on both but every
Claude dispatch, probe, and switch is coordinated through the server-side owner,
with the Mac reached via the existing peer channel for credential moves on
Mac-owned homes. The actor is therefore a single process-local module with
state keyed by `(provider, runnerMachine)`; no cross-machine coordination of
the actor itself is needed. A Mac-side credential move is still performed by
the Mac over the peer channel, but the authoritative selection record and
revision counter live on the server. If the peer channel is down mid-switch,
the credential move refuses before the server-side `operatorSwitched` call is
reached, so the actor does not commit a half-state.

**Entity:** `AccountFacts(provider, runnerMachine)` — one record per
`(provider, runnerMachine)` tuple. It holds:

- Which account label is currently selected by the operator.
- For each known account on this machine: its home, sign-in state, credential
  expiry, latest reading (windows and problem flag), active refusals (per model
  for Claude, account-wide for Codex), last proven turn.
- A monotonically increasing `revision` (a plain integer, bumped on every change).
- The clock-time of the last write.

**One writer:** the `AccountStateActor`, one instance per `(provider, machine)`,
living in the owner process (`execution-host.ts`'s parent). Every state-changing
event enters through its typed methods:

- `operatorSwitched(account, source)` — the Accounts panel switch.
- `credentialsRewritten(home, account)` — the on-disk auth file changed.
- `probeReading(account, windows, readAt, problem?)` — the usage probe delivered
  a reading (or a problem).
- `refusalObserved(account, model, resetAt, observedAt)` — a 429 from a real turn.
- `signInAppeared(account, home)` / `signInDisappeared(account, home)` — discovery.
- `turnProvenOn(account, home, provenAt)` — a real turn succeeded.

No other code path writes any of the stores that back `AccountFacts`. The old
write sites (`setRunnerAccountInUse`, `putCodexAccountInUse` direct cache writes,
`markClaudeHomeVerified`, the periodic usage reader's SQLite write, the Accounts
panel's direct credential move) all become *callers* of the actor's methods and
return the actor's new revision.

### 2. Operation identity

Every event carries a `(provider, machine, revision)` triple. Revisions are
strictly monotonic per `(provider, machine)` and durable: the actor flushes its
`revision` to SQLite before publishing an event. A restart reads the stored
revision and continues from there. An event with an older or equal revision than
the subscriber's last-seen is discarded (idempotent delivery — a replay is safe).

Operator switches additionally carry a `switchId` (uuid) minted at the panel
click; the actor records which switch produced the current selection, so a late
identity lag is distinguishable from a new switch.

### 3. Acceptance ladder

For an operator switch:

1. **Recorded by us:** switch row written in SQLite with switchId and target.
2. **Admitted by the transport:** credential file moved into place on the target
   machine, verified by re-read. This is the step that was the *entire* contract
   before — now it is one rung.
3. **Saved durably by the receiver:** actor's `operatorSwitched(...)` returns a
   committed revision. Held work is released in the same transaction. Subscribers
   are notified synchronously before the method returns.
4. **Shown to the person:** Accounts tray and session dispatcher observe the new
   revision on their next read.

For a probe reading:

1. Reading taken at the provider.
2. Actor's `probeReading(...)` writes it. If it contradicts the current selected
   account (e.g. says the current account is at 100% but there's another with
   room), auto-switch is triggered in the same tick.
3. Subscribers notified.

### 4. Provisional and retained state

The Accounts tray UI shows the actor's current snapshot — never a local copy.
When the operator clicks switch, the UI shows "switching to X…" (provisional)
while the credential move is in flight. The actor returns a `committed` or
`refused` outcome, which the UI merges by `switchId`. A refresh in the middle
of a switch reads the actor's current state — if the switch hasn't landed yet,
the tray shows the pre-switch account with a pending switchId tag; if it has,
the tray shows the new account.

The authority (`canTakeWork`) remains a pure function, but its input stops being
"look things up in four stores." Instead the actor exposes a `snapshot()` that
returns an immutable `AccountFacts` and `canTakeWork(snapshot, account, model)`
reads only from that snapshot. A caller holding an old snapshot gets consistent
answers for its lifetime; no partial reads.

### 5. Lifetime

The actor lives in the owner process (`SessionExecutionHost`). It is initialized
at owner start from the SQLite row (or a fresh zero state if first run). It
owns no subprocesses of its own; the usage reader, credential watcher, and
dispatch picker are collaborators that call its methods.

The usage probe — the thing that polls the provider's `/usage` endpoint — is a
separate timer-driven collaborator that calls `probeReading(...)` on the actor.
Its lifetime is independent of the actor; if the probe process dies, the actor's
state stays live with the last-good readings, and `canTakeWork`'s `last-showed-room`
and `proven-attempt` rungs keep dispatch running until the probe recovers.

External credential changes (someone runs `claude /login` directly, or a Codex
CLI rewrites `auth.json` outside the actor) are not auto-detected by the actor.
The Mac keychain is not file-watchable — Security framework changes raise no
inotify/FSEvents events — so a file-watch is not a reliable back-channel
closer. Instead, the next usage probe cycle (every ~3 minutes) reports the
observed identity via `probeObserved(...)`, which updates the actor's record
through the same gatekeeper path. The actor's invariant is weaker than
"every external change is visible in the same tick" and stronger than
"consumers can read a consistent state at any time": a quiet external change
causes at most one probe cycle of lag before the actor and its subscribers
converge, and `OPERATOR_PRECEDENCE_MS` ensures a deliberate operator switch is
never shadowed by that probe-cycle lag.

### 6. Old readers

The deployed release currently reads from several stores directly. After this ships:

- `currentAccount(provider)` — becomes `actor.snapshot().selected`.
- `storedUsage(provider)` — becomes `actor.snapshot().readings`.
- `codexAccountWithRoomWhileInUseIsSpent()` — becomes a query over the same snapshot.
- `claudeAccountCachedReset()` — becomes a read of `snapshot.refusals`.
- The Accounts panel's direct credential move — becomes `actor.operatorSwitched(...)`.
- The usage reader's SQLite write — becomes `actor.probeReading(...)`.

**One release only ever runs against its own actor.** The release doesn't need to
be compatible with "an older subscriber reading an older store" because the old
stores are removed from the binary at the same time — we're not shipping both
read paths. The SQLite tables are kept read-compatible (we add a new events table,
we don't rename or drop old columns), so a rollback brings back the old release
reading the old tables; the actor's events table is simply ignored.

### 7. Failure trace

Yesterday's Codex switch, replayed under the new design:

1. Before: `AccountFacts(codex, ax41).selected = tejastej.dc@gmail.com`,
   `readings[tejastej.dc@gmail.com].weeklyUsedPercent = 100`, held turn queued.
2. Operator clicks switch to `tejas@chann.app`. Accounts panel calls
   `actor.operatorSwitched(tejas@chann.app, switchId=X)`.
3. Actor moves credential file (step 2 of acceptance ladder), confirms re-read.
4. Actor commits revision `N+1`: `selected = tejas@chann.app`, releases every
   queued held Codex turn whose binding is unspecified, publishes event.
5. Subscribers notified synchronously: dispatcher now sees the new selected
   account, the released turn is picked up on the next dispatch tick.
6. Refresh of the Accounts tray reads revision `N+1`. Tejas sees the new
   account marked current. The probe catches up to the new identity on its
   own cycle; the system doesn't wait for it.

If the credential move fails: the switch handler's existing `move.undo()`
rolls the file back, and `operatorSwitched` is never called. The actor stays
on its prior selection; no revision bump, no event. If the move and
activation both succeed but the process crashes before `operatorSwitched`
returns, the file is advanced while the actor is not — on next startup, the
actor initializes empty for that provider, and the first probe observation
sets the selection to whatever the credential file now reports. That's a
one-probe-cycle inconsistency, bounded and self-healing, not a permanent
split. The actor explicitly does not claim atomicity across the credential
move and the revision commit; it claims durability once `operatorSwitched`
returns.

If a probe reading comes in during the switch: the probe calls
`actor.probeReading(...)` which queues behind the switch's lock on the actor.
The reading applies at revision `N+2` against the new state. No race.

If two switches overlap: the actor serializes them. The second switch sees the
first switch's revision as its baseline. The last writer wins; both switchIds
are recorded in audit history.

### 8. Falsifying sequence and the check

Six replayable tests that **must** pass before shipping. Each is one incident
turned into one test.

| # | Incident date | Sequence | Pass condition |
| - | ------------- | -------- | -------------- |
| 1 | 2026-11-21 Codex switch | Seed held codex turn + exhausted account. `actor.operatorSwitched(fresh account)`. | Within the same tick: `canTakeWork(snapshot, fresh, *)` returns ok; held turn's `dispatch_hold` is cleared. No probe call needed. |
| 2 | 2026-11-21 Claude probe | Seed two accounts with last-good readings showing room. `actor.probeReading(account1, windows=[], problem="unreadable")`. | `canTakeWork(snapshot, account1, opus)` returns `last-showed-room`, not `unknown`. Dispatch picks a candidate. |
| 3 | 2026-11-19 Opus-only | Seed refusal for `(acct1, opus)`. Ask `canTakeWork(snapshot, acct1, sonnet)`. | Returns `ready` (model-scoped refusal doesn't block another model). |
| 4 | 2026-11-06 Codex retirement | Seed refusal for codex acct1 resetting Nov 25. Fresh reading comes in: windows all < 100%, no window resets within 60s of Nov 25. | Refusal retired automatically; `canTakeWork(snapshot, acct1, *)` returns `ready`. |
| 5 | 2026-11-02 Mac sign-in wait | Seed account with 54% free reading but no sign-in on this machine. | `canTakeWork(snapshot, acct, *)` returns `no-home`, not `ready`. |
| 6 | 2026-10-15 stale reading | Seed reading from 10 days ago showing 19% used, no refusal. | `canTakeWork(snapshot, acct, *)` returns `last-showed-room`. |

Plus four adversarial tests that have no incident but are the invariants:

| # | Invariant | Sequence | Pass condition |
| - | --------- | -------- | -------------- |
| A1 | Switch is instantaneous for consumers | Start a switch; before it returns, read `actor.snapshot()` from another thread. | Snapshot is either entirely pre-switch or entirely post-switch, never partial. |
| A2 | No consumer can reach around the actor | Grep the compiled binary and the source for direct reads of `auth.json`, `storedUsage`, `currentAccount` as a public API, bypass calls to the runner identity. | Zero hits outside the actor module and its unit tests. |
| A3 | Stale runner identity does not mislead | Simulate the runner identity call returning the pre-switch account for 300 seconds after a switch. | Switch still releases; dispatcher never selects the stale account; no event the subscribers see names the stale account. |
| A4 | Two concurrent switches resolve deterministically | Call `operatorSwitched(A)` and `operatorSwitched(B)` from two threads. | Serialized; one revision wins; both switchIds in audit; no partial state. |
| A5 | A snapshot held across a switch does not win | Consumer reads `snapshot()`, then an operator switch commits, then the consumer dispatches using the old snapshot. | Dispatchers must re-snapshot at dispatch time or subscribe to invalidate. Snapshot interface documents this; a held snapshot is a read-only value, not a reservation. |

The invariants are enforced at runtime too: the actor asserts that its selected
account is one of its known accounts; that revisions are strictly monotonic;
that no subscriber call leaks a mutable reference. A violation panics loudly in
dev and logs loudly in prod.

## Scope boundary

In scope:

- The actor, its typed methods, its SQLite persistence, its event stream.
- Migration of every current writer (switch, probe, refusal recording, sign-in
  discovery, home-proof write, per-session binding) to call the actor.
- Migration of every current reader (`canTakeWork`, auto-switch picker, release
  loop, Accounts tray, session dispatch, external usage display) to use the
  actor's snapshot or subscribe to its events.
- The ten falsifying tests. The usage probe and credential watcher as
  collaborators (small refactor; they already exist, they just call the actor now).
- Deleting the old parallel read paths from the binary.

Out of scope:

- Reworking the Claude session-owner header, the provider contract, or the
  runner lease protocol — those are orthogonal.
- New account providers.
- UI design changes in the Accounts panel beyond the switchId tag.

## Deviation from stateful-shapes library threshold

The skill's `library-thresholds.md` recommends reaching for a heavy library only
when the failure mode demands it. For an actor-per-entity shape with ≤ 6
accounts × 2 providers × 2 machines = 24 entities, no network partition between
actor and consumers (same process), and bounded concurrency, a plain TypeScript
class with a mutex and a durable revisioned write is the right tool. We are
**not** pulling in XState, Temporal, Durable Objects, or Orleans. The actor is
~400 lines. The complexity we're taking on is the discipline of the single writer
and the event stream, not the machinery.

## AWS Well-Architected checklist — operating-profile-sized

- **Operational excellence:** every state transition emits a structured log with
  revision, event type, cause, and outcome. Grafana panel shows revisions per
  minute per `(provider, machine)` and the time between an `operatorSwitched`
  event and the first downstream `canTakeWork` call returning the new account.
- **Security:** credentials remain on the machine that owns the account home.
  The actor never carries a credential across machines. The Accounts panel
  switch is authenticated as the operator (existing thnkr.ing auth).
- **Reliability:** state durability is SQLite with `PRAGMA synchronous=FULL` on
  the actor's events table; restart recovery is exercised in test A1. The actor
  is a single point of failure for writes by design — the alternative is the
  current fragmentation. Reads are available through the snapshot even when the
  actor's write lock is held (snapshot is a copy-on-write struct; readers never
  block writers). Target: zero "my account switch didn't take" incidents in the
  12 months after ship.
- **Performance:** a switch commits in O(1) SQLite rows; subscribers receive
  events synchronously (same process). A snapshot read is a struct clone, ~1μs.
  Nothing is at risk of scale.
- **Cost:** no new infrastructure. Deletes code; adds one SQLite table.

## Build sequence

1. Write actor + unit tests (incidents 1–6 and invariants A1–A4). No callers yet.
2. Switch `canTakeWork` to take a snapshot. Every existing caller gets the
   snapshot from a temporary adapter that reads the old stores — no behavior
   change yet.
3. Convert each writer in turn (switch → probe → refusal → sign-in → home-proof),
   each as its own commit, each verified against the incidents.
4. Delete the temporary adapter; readers now go to the actor directly.
5. Delete the old parallel read paths (`currentAccount` as a public function,
   direct `storedUsage` reads, etc.).
6. Single `/code-review high` pass; address CONFIRMED findings; targeted second
   pass only if a new blocker surfaced.
7. Ship end-to-end: merge, deploy, live-check an actual switch on the running
   service.
8. Independent review agent verifies the goal is met per the acceptance ladder
   in this card.

## What "never again" means and does not mean

I can guarantee:

- Every state change goes through one writer. Consumers see every change in order.
- A switch releases held work in the same transaction. No probe wait.
- A probe failure cannot discard last-good readings; `canTakeWork` continues to
  answer from the stored facts.
- The ten falsifying tests pass, forever, as the regression fence.

I cannot guarantee:

- That a future *new* class of failure (a provider changes their API shape, a
  runner disk fills up) won't produce a new incident. What I can guarantee is
  that the design admits each new signal cleanly: it becomes one new event
  type on the actor, not a new parallel store.

The 5-nines target is for the known failure classes, not for every possible
future surprise.
