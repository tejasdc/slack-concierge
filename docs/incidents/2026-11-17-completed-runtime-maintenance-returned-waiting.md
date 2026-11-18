---
failure: A completed runtime replacement returned waiting again and reclosed admission when later work was active.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# Completed runtime maintenance returned waiting again

## What was seen

The exact source-bound runner operation was durably applied: the original listener was gone,
the recorded replacement was live and masked, and a fresh managed agent independently proved
image-open denial and its ordinary authenticated API access. The owner's repeated command still
returned waiting under later work. The original action and required release had not changed.
These are separate evidence layers; fresh agent acceptance did not repair the missing owner
receipt. The exact historical invocation that released admission was not independently traced.

## Cause

Only the public request handler saved the maintenance action's receipt. Automatic progress could
prove the replacement and release its holder without saving completion. A later retry recreated
that holder and hit the idle guard before discovering that the runner had already applied it.
The unconditional handler write could also overwrite a newer terminal receipt with stale progress.
The protective idle guard was not itself defective and never authorized interrupting active work.

The composed disposable reproduction against the original source reaches applied on the runner,
releases the exact hold, and still reads waiting from the retained owner action. It does not
claim that automatic recovery was the particular production invocation that released the hold.

## Fix

Direct and automatic progress share the canonical owner's monotonic receipt transition. Full
terminal completion and removal of only its matching durable holder commit atomically before
the admission projection changes. Failed receipt persistence or hold deletion rolls both back.
Stale waiting/uncertain progress returns the already-applied result without replacing it.

A distinct non-mutating read over the existing runner channel returns only this operation's
historical applied result plus current exact-generation proof. The distinct method is necessary
because an older runner could ignore a new option on the old mutating method. Missing/unknown
methods and malformed observations stay conservative. The observation never writes, reserves,
signals, starts or progresses pending work. Terminal results are never regressed into a new drain.

The owner verifies the runner's masked replacement/API evidence, repeats its own model API read,
and rechecks the same replacement before terminal settlement. Applied historical records can
reconcile under later active work without recreating a holder or repeating the effect. A changed
or missing replacement retains historical completion and reports uncertainty separately. Pending
operations keep the ordinary owned/native idle guards and all original binding/session checks.

Pre-release specialist checks found and reproduced three additional defects in the first local
candidate: a default proof client/ordinary receiver could manage a missing daemon; failed terminal
journal publication dropped the runner fence and trapped retry; malformed replacement identity
could compare equal through missing fields and release the owner holder. None was released.
Proof now uses non-managing direct access plus a retained protected lane on the persistent owner
client, leaving ordinary active RPCs/recovery intact. Durable runner completion requires both
applied phase and published applied status; failed publication retains fences, and the same
operation can reprove/publish only its existing terminal effect after storage returns. Observation
remains read-only. One valid process-identity predicate guards comparison and terminal settlement.

## State card

- **Entity/writer:** the original retained maintenance action and exact holder are written only by
  the canonical owner; the runner owns the existing fsynced operation journal and runtime effect.
- **Identity:** operation, source input/run, action, runner and required release are immutable.
- **Acceptance:** runner applied is durable effect evidence; owner completion is a separate
  transaction; a reopened queue is published only after that transaction. Agent acceptance is
  still independent and does not manufacture either receipt.
- **State/lifetime:** the owner hold map is a projection of durable holders. Existing startup and
  execution-change recovery reconcile the same action; there is no new operation, store or job.
- **Old readers:** rows keep their existing shape. Older runners reject the distinct observation
  method without executing the mutating method; absence never becomes permission to progress.
- **Failure trace:** runner applies; answer/owner receipt is lost; later work starts; retry reads
  exact terminal evidence without mutation; owner commits receipt plus exact release atomically.
- **Falsifier:** automatic completion, restart, response loss, stale waiting, active pending work,
  generation mismatch and persistence failure run through real disposable action/hold/journal
  boundaries. The original source fails the missing-terminal-receipt assertion.
  Actual-client/receiver disappearance checks, runner write/fsync/rename failure/recovery and the
  demonstrated malformed replacement response also fail the first local candidate and pass the
  correction without real runtime effects.

## Acceptance scenario

- **Seed:** an exact retained maintenance action, its real durable holder and runner journal in
  disposable directories; complete it automatically or seed its historical applied journal.
- **Action:** retry the original public command after later shared work; repeat after owner
  restart, a lost applied response, stale progress and failed receipt/holder commits. Probe
  changed binding/session, old/malformed observation and missing/changed replacement cases.
- **Expected:** automatic completion saves full applied evidence before releasing only its
  holder. Later retries return the same terminal result without reholding, signaling or starting.
  Stale responses cannot regress it. Incomplete active operations still wait. Generation/health
  uncertainty retains history without another drain; failed persistence keeps durable and
  projected admission conservative. Other account/re-home/maintenance holders remain intact.
  Terminal publication failure keeps runner fences until same-operation persistence-only recovery;
  read-only proof cannot manage the daemon; malformed identities cannot release admission.
- **Replayable offline:** yes; run `bun run scripts/runtime-terminal-reconciliation-fixture.ts`
  and `bun run scripts/codex-runtime-maintenance-fixture.ts` from `bot/`.
  Run `bun run scripts/runtime-terminal-proof-fixture.ts` for actual client/receiver proof boundaries.
