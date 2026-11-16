---
failure: The agent ledger kept growing because successful copying of an older snapshot did not recycle the current journal.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# The ledger kept appending after a successful copy

## What was seen

The standing repair agent's November 15 service notice opened this repair. There was no new
incident-specific human capture; the standing repair authority and agent delegations retain
their separate provenance. Earlier guesses about a continuously pinned reader were superseded
by continuous header/lock evidence: 16,215 bounded samples over 200 seconds showed a checkpoint
copying through frame 2,004,669 while concurrent commits advanced the live tail to 2,004,730.
It reported success for its older snapshot. The newer 61 frames remained uncopied; later
reader gaps and commits appended without a generation reset. This establishes that observed
cycle, not every historical growth or filesystem-space change.

## Cause

The old worker independently performed PASSIVE once unchanged byte/pressure eligibility opened.
Snapshot equality was treated as enough to make the owner's next write recycle. Concurrent
commits could outrun that snapshot; the existing byte gate deferred the smaller remaining tail.

Replacing only the operation with RESTART is also insufficient. It occupies the native writer
lock during synchronization, and the first next-generation NORMAL write synchronizes the WAL
header. Both waits can land on the synchronous owner without a complete-operation boundary.

The pinned Bun runtime adds a distinct failure path: its worker VM termination sweep explicitly
attempts TRUNCATE for still-registered SQLite connections. A checkpoint worker exiting after a
successful prime can therefore reset the WAL before the owner's exit/error callback runs.
PERSIST_WAL and SQLite NO_CKPT_ON_CLOSE do not suppress that explicit checkpoint. The exact
installed-revision implementation is Bun
`744846f844374847c902b5e7fd59b4342a51ef99`,
`src/jsc/bindings/sqlite/JSSQLStatement.cpp`, `Bun__sqliteCheckpointForTermination`.
Ordinary close, own-error/exit hooks and parent termination have different native lifetimes.
That sweep also holds Bun's process-global SQLite registry mutex during native synchronization.
Freezing mutations cannot keep the owner responsive if a forced sweep blocks its unrelated
SQLite getter. Supported independently selected legacy helpers can cause the same canonical
lifetime problem; ordinary FULL transactions remain compatible outside the new recycling epoch.

## Fix

The canonical owner retains complete synchronous operations and reacquires lexical permission
after each external await. The canonical SQL facade refuses an unadmitted writer before native
execution, including prepared/native statement and transaction-database aliases. Provider
consumption is ordered and retained before terminal/result settlement; control replies continue
independently of held data. Existing execution-host journals and exact native Codex history remain
the recovery authorities. Transient UI notification versions acquire no new crash-durable contract;
the repair adds no notification archive, second ledger writer or independent release authority.

At unchanged eligibility the owner freezes mutation admission, obtains the existing original
descriptor's durable frontier, and grants one epoch to its checkpoint worker. Actual RESTART
and a FULL exact-current-value signed metadata transaction complete while that frontier is
fixed. Successful nonempty/unbackfilled priming precedes resume. Metadata maintenance is not
application receipt coverage; matching original sync IDs remain required.

The finite private worker closes its known native SQLite resources cooperatively. Retirement
requires an exact cleanup certificate and its own exit; a refusal retains the worker and epoch
instead of entering the destructive termination sweep. The owner never force-terminates an
attached checkpoint worker. Readiness, timeouts, stale success and replacement descriptors cannot
discharge the grant. No runtime checkpoint-inspection raw descriptor is introduced; generation
proof remains fixture-owned.

Existing release selection closes future supported helper launches before capturing prior
selected lifetimes and queued managed intents. Separate short selection and inherited lifetime
descriptors let a successful deploy child return before its enclosing supervisor finishes.
Pending handover is retained in existing release events; existing reconciliation proves final
native cleanup, initial prime and original receipt before enabling recycling. Serving deployment,
drain and recovery mutations use complete owner commands. Verified legacy/old-LKG behavior stays
compatible, without treating socket failure or mutable application pointers as authority.

## Acceptance scenario

- **Seed:** A disposable WAL database on Bun 1.4.2 / SQLite 3.53.2, one continuously retained
  canonical connection and original WAL descriptor, finite old/new readers, original sync and
  checkpoint workers, an actual owner request paused at an external project-preparation await.
- **Action:** Hold actual checkpoint main-db fsync while another writer would extend its tail;
  compare the old PASSIVE source with owner-controlled recycling. Release a pending owner
  request while admission is closed. Independently hold worker primer-header fsync and successive
  original-descriptor fdatasync calls. Exercise normal/own-error lifetimes and the historical
  parent-termination negative control,
  wrong epochs, stale worker/sync replies, provider callback bursts and terminal/result drain.
- **Bad result:** Old PASSIVE reports a complete captured frontier H while fresh live M>H and
  later writes keep the same generation; or an owner writer enters during maintenance; or a
  resumed owner performs header fsync; or a response/later effect escapes an earlier sync;
  or an acknowledged input, callback identity, steering attribution or retained source is lost.
- **Expected:** The old causal oracle fails the repair invariant in three actual PASSIVE
  cycles. The candidate fixes a finite frontier, preserves finite reader snapshots, creates
  repeated new generations on the worker, keeps native HTTP control live during each distinct
  sync hold, retains exact accepted identities and consumes provider sources in order, and
  releases receipts/effects only under their exact original-descriptor proof.
- **Replay:** Short guards are `bot/scripts/ledger-admission-fixture.ts`,
  `ledger-steps-fixture.ts` and `ledger-canonical-admission-fixture.ts`.
  `ledger-recycling-fixture.ts` exercises real worker reuse and native exit cleanup.
  `ledger-recycling-protocol-fixture.ts` exercises the actual coordinator body with a controlled
  worker import boundary. `ledger-recycling-owner-composition.ts` and
  `ledger-recycling-sync-latch.c` exercise the real owner/native workers/fences with distinct
  checkpoint, header and original-descriptor sync latches. Retained historical-source moving-tail
  and producer oracles are included with the implementation review evidence.
  Cooperative worker-lifetime, pre-grant refusal, installed launch schedules, application-owned
  capability packaging, handover receipt and final-native-thread checks cover the added lifetime
  boundary. Controlled systemd/provider collaborators are named in each fixture report; they do
  not establish installed production behavior.

## Evidence boundary

Source, disposable runtime, installed release, browser and physical-device acceptance are
different proof layers. The fixing source candidate changes no production ledger or process;
no production reclaim, installed behavior or power-loss guarantee follows from these checks.
Logical generation reuse is reported separately from file length and allocated blocks.
Old readers or providers producing indefinitely imply no global finite-time/byte bound.
Current architecture and full runtime/failure rules live in
[ledger durability](../architecture/LEDGER-DURABILITY.md#wal-recycling-admission).
