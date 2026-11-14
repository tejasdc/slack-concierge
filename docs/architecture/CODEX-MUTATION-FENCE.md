# Managed Codex mutation custody

This describes the source candidate, not an installed release. Accepted-binding
continuation activation is **held**. The execution host refuses
`LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN` and
`COLD_RESUME_HOOK_CONFIGURATION_UNPROVEN` before reservation or submission.
The designer owns those prerequisites, coordinated release and live acceptance.

## Common forwarding boundary

The local App Server bridge and owner's runner relay use the same mutation
channel. The versioned `codex-launch` control helper supplies that channel for the
supported Desktop raw WebSocket proxy. The stable command-line-tools wrapper
delegates its complete original argv to the sealed helper; classification and
policy stay in Concierge. Native proxy stdio is a byte stream carrying WebSocket
handshake/frames, not JSON lines. The helper terminates that WebSocket locally and
gates decoded client messages before forwarding to the original native socket.
Server requests and read responses remain available.

Explicit reads pass through. Other methods, unknown notifications and client
answers to native server requests obtain owner permits. Unknown scope is global.
A permit is durably consumed before synchronous forwarding. A connection-local
queue orders frames but supplies no authorization. Consumed permits remain issued
after send failure, lost receipt, disconnect or restart. RPC errors may follow
effects. There is no lease expiry or disconnect/finally release. Duplicate
outstanding JSON-RPC IDs refuse rather than replacing correlation.

An exact-thread reservation conflicts with earlier outstanding exact-thread or
global intents and revokes unused competing permits. Other threads keep their
custody. Resume, settings, history injection and steering cannot bypass the fence
by preceding the model-start hook.

Successful `thread/start` and matching `thread/resume` replies complete only their
own setup intents: the pinned native handlers send these after construction or
resumed-state materialization finishes. They do not settle an asynchronous provider
turn. Exact owned native-terminal callbacks settle ordinary starts, steering and
interruptions only when durable native-turn identity matches. A missing start reply
with no retained native-turn identity stays uncertain. Submitted settings,
compaction and unknown methods stay outstanding without their own proven
completion witness. See the pinned
[thread processor](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/app-server/src/request_processors/thread_processor.rs)
and [turn processor](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/app-server/src/request_processors/turn_processor.rs).

## Supported writers

| Entrance | Candidate mediation | Acceptance still needed |
| --- | --- | --- |
| Local owner native client | App Server bridge and common owner permits | Installed bridge/native behavior |
| Runner client | Owner runner relay before remote forwarding | Remote process coverage; accepted-binding recovery refuses remote execution |
| Desktop SSH `codex app-server proxy` | Stable wrapper, sealed helper, decoded WebSocket gate | Existing unmediated connections and previously issued handlers |
| Root TUI/picker, interactive resume/fork | Durable global lifetime intent before native child creation | Startup UUID does not constrain later in-process thread selection |
| Noninteractive exec resume with an explicit UUID | Durable exact-thread lifetime intent before native child creation | Fixed one-shot target; unresolved lifetime blocks conflicting recovery |
| Exec fork and other direct CLI commands | Durable global lifetime intent before native child creation | Fork creates another thread; unproven command scope stays global |
| Managed local account activation/replacement | Global lifecycle intent in the same mutation ledger before restart/stop/replacement | Only actual verified managed-daemon health settles it; failures remain outstanding |
| Runner account activation/re-home | Actual owner relay gates the lifecycle call before buffering or forwarding | Explicit terminal handler results settle it; error, unknown result and lost receipt hold it |
| Help/version and wrapper capability read | Side-effect-free handling | Capability support does not prove connection drainage |

The Linux owner checks native executable, PID/start identity and managed
registration; it identifies the actual native socket listener independently.
Registration must establish sealed launcher parent identity and argv
classification. A caller's `mediated` claim is insufficient. Child exit is checked
independently against process identity before releasing a CLI lifetime. Process
disappearance cannot settle already issued App Server mutations. Administrator
socket/file bypass is outside the supported application writer boundary.

Retained Mac evidence establishes the actual Desktop SSH path to the old server
proxy. That proxy is unmediated. Closing it or observing idle cannot prove that
started native handlers finished. No reviewed supported drain witness is yet
implemented. Neither a helper capability response nor a current process inventory
replaces that missing proof.

Interactive TUI scope is global even with an explicit startup UUID: native 0.166
supports attaching another saved thread through `/resume` and the Agents picker
without process exit. See the pinned [in-process picker](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/tui/src/app/session_picker.rs).
Only the inspected noninteractive `exec resume` path with an explicit UUID uses
narrower custody. `exec fork` creates another thread and remains global; see the
pinned [one-shot command implementation](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/exec/src/lib.rs).

Lifecycle and thread admission are mutually exclusive in the same immediate
transactions. A queued recovery fence is sufficient to defer restart; a running
turn count alone is not. An issued lifecycle blocks every native writer and new
recovery fence until explicit completion reconciliation. Unrelated runner-machine
calls continue. Start-if-absent remains a distinct prerequisite and does not stop
or replace a live daemon. No lifecycle intent expires or releases in `finally`.

## Continuation, exact input and one attempt

The existing recovery command selects only the exact service report-back under
current open work custody. Its accepted-binding decision proves retained creation,
acknowledged prior work, model/effort/thread/generation/runner, exact source pair
and the complete accepted interval. It is distinct from explicit human tier choice
and grants no unrelated top-model work. Never-admitted inputs, steering, controls
and actual scheduler predecessors count. Similar reminder text never supersedes
or transfers custody.

The internal composition acquires the exact-thread fence, reads complete native
attempt/item pages by durable identity, repeats the native watermark and compares
the owner snapshot atomically with reservation. Independently mapped compaction
can be neutral only with complete coverage. Acknowledgement, output, tools and
uncertain effects refuse. Later bytes and immutable results remain unchanged.

Authorization binds that reservation and one extra dispatch. Provider-admission
intent spends the attempt budget before forwarding. Only a hash of the ephemeral
dispatch capability is retained. Owned resume/start preserve exact model and
configured effort. Persisted execution metadata excludes capability and prompt.

The synchronous managed hook sends invocation identity and the digest of the
actual native hook prompt. The owner matches that same authorization, thread/turn,
input/run, binding and prepared prompt. Transport retries retain one invocation;
a different invocation refuses. All models reach the owner, including non-Astra.
Allow/refusal audits separate configured effort from unknown observed effort.
No prompt or secret bytes are logged.

Native 0.162 hook timeout/error may fail open. The hook is an additional exact-input
check and diagnostic; pre-forward authorization is independently required.
On-disk registration and helper pinning do not prove warm runtime activation.
The internal native proof refuses warm state without activation evidence; current
cold reconstruction/config proof is separately missing. Historical `notLoaded`
is not current eligibility.

## Stop and progress

Canonical Stop, session Pause, Archive and model changes stop active reservations
inside the existing retained-control transaction. Global Pause respects its
existing generation exceptions and project-router/outside exclusions. These
controls revoke unused permits while issued intents remain blockers; Continue
and Restore do not reactivate a stopped reservation.

The live dispatcher, or an adopted execution with
canonical Stop/pause/archive evidence, may interrupt only the exact issued turn.
An interrupt RPC reply does not prove terminality. The actual provider callback
retains exact input/run/dispatch/thread/turn evidence. Completion and the existing
restart sweep reconcile only matching starts/interrupts from that witness. A late
response adds its receipt without reopening terminal custody. Missing/conflicting
witnesses remain outstanding and cannot trigger another provider attempt.
Ordinary terminal reconciliation currently requires the matching current owner
dispatch. A historical callback whose owner has advanced to another dispatch
refuses `NATIVE_TERMINAL_OWNER_IDENTITY_UNPROVEN`; it does not infer identity from
timing or substitute an unrelated result.

Reservation, attempt, hook allow, native terminal, input acknowledgement and useful
work are separate facts. Native terminal can be confirmed without hook/ack;
useful work remains unassessed. The writing session reconciles its own authorized
obligations. Recovery never closes, transfers, cancels or replays them or children.

## Verification boundary

Focused fixtures compose real SQLite owner/permit/queue paths, actual bridge,
runner relay and raw WebSocket helper with independent clients and barriers.
These prove source contracts. They do not prove installed selection, old native
handler drainage, current hook activation, live delivery or useful work. The
production accepted-binding entry remains guarded until both missing supported
capabilities are implemented and reviewed. See the
[incident](../incidents/2026-11-13-writing-continuation-eligibility.md).
