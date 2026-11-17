# Ledger image boundary: same-account runtime maintenance

Invariant: no accepted owned or external native turn is interrupted, replayed or force-killed to
activate the mask. Personal operating profile: one server daemon, one operator, Mac clients.

## Decision

Use the existing owner admission/restart lock and runner same-account re-home machinery, with
an explicit source-bound maintenance operation. Do not misuse account switching or daemon
stop/restart: the former changes identity and the latter imposes a 60-second forced deadline.
Doing nothing leaves the already-running daemon unmasked. SIGHUP is the installed 0.166.0
App Server's graceful-only native drain: it closes native admissions under the same lock as
turn admission and waits all admitted work, without the Forceable signal's second-signal path.
This resolves external native starts racing an idle snapshot without a new proxy or watcher.

Pinned upstream authority: codex-rs/app-server/src/lib.rs and turn_admission.rs at rust-v0.166.0.
Primary reviewer and parent independently verified the exact loaded listener executable version.

## State card

- Entity/writer: one runtime-maintenance operation. Owner writes its existing durable admission
  hold; runner writes its existing activation journal extended with a distinct runtime operation.
- Identity: source input, source run, stable action, target runner and required source commit
  determine immutable operation identity. Runner captures boot ID + exact control-listener PID +
  process start ticks before any signal. No account/credential mutation.
- Acceptance: accepted durable hold -> active work deferred -> runner drain intent durable ->
  SIGHUP delivered to exact supported generation -> native exit observed -> wrapped start ->
  exact replacement listener image mask and model/API probes -> applied -> owner admission reopens.
- Retained state: distinct maintenance hold recovery kind; generic account/re-home success may
  never remove it. A retry returns/progresses the same operation. The outside worker owns delivery.
- Lifetime: outside worker concierge:10028 can progress this operation after parent finishes.
  Existing execution-change recovery and startup restore pending holds. No new timer/service.
- Old readers: unsupported runner refuses before signal; owner retains admission pending exact
  recovery. Journal restart restores runner auto-start/account/re-home fence before startup.
- Lost response: if drain intent is retained, reconcile exact generation. Wait while alive;
  after its exit start only if no replacement exists. Recovery may re-deliver SIGHUP to the
  verified original generation: every SIGHUP is GracefulOnly, bridging a crash after drain intent
  but before signal without a forced second-signal path. If replacement exists, prove its mask
  and health before applied. Never replay a destructive daemon restart on uncertainty.
- Falsifier: native admission races preflight idle, then holds a turn beyond 60 seconds; operation
  must remain draining with no forced stop, preserve the accepted turn, and complete once idle.
  Fault fixture also restarts coordinators after signal/start response loss and checks one effect.

## Execution shape

`sessions codex-maintenance` takes ordinary exact source flags, stable action and required commit.
The owner durably closes admission before checking shared owned/external activity. A shared
requesting turn is never excluded; a retained outside CLI placement is independent of this
daemon and does not self-block. If busy it returns waiting while preserving intent; the outside worker may
retry the same command. Under the existing restart lock it calls the runner's maintenance method.
The runner validates its loaded source contains the required commit, serializes with existing
account/re-home operations, restores its durable auto-start fence, validates exact loaded daemon
supports graceful-only SIGHUP, reads native activity, records generation-bound drain intent and
requests graceful-only drain. Pending drain returns without a force deadline; same-operation progress waits for
that exact generation to exit. It starts through the installed image boundary and proves the
replacement image is the inaccessible 0:0 device and model/list answers before owner reopens.

The command returns explicit waiting/draining/uncertain/applied state. Uncertain retains admission;
only verified applied reopens it. The outside worker posts installed acceptance back to the original
request/thread and the original request remains open until then. Existing individual hosts are
never stopped for acceptance: they finish, and fresh installed disposable agents prove new coverage.
