# Managed Codex mutation custody

This describes the source candidate, not an installed release. Accepted-binding
continuation activation is **held** on `LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN`
and `FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN`.
The source has a private original-history reader, configuration-writer exclusion
and an actual cold-resume construction binding, exercised against disposable
state and an App Server stand-in. Original history and cold construction are
per-operation evidence checks with precise refusals when their predicates fail.
No current target eligibility, installed construction, invocation, delivery or
useful work is claimed. Local fixtures cannot supply the legacy admission cut.

The existing file-only release compatibility mechanism retains a monotonic
requirement before protected authority. Activation, rollback, startup and control
recovery require compatible sealed application and controller capabilities;
modern control cannot certify an old application in a hybrid. The requirement is
never automatically removed on idle, terminality or rollback. This changes old-LKG
eligibility: incompatible artifacts refuse. Requirement publication is not atomic
with SQLite and is not proof that old requests/helpers/configuration writers have
been excluded. That first transition has no supported host witness here, so the
operational path refuses precisely; early deployment preflight refuses before
stopping the existing service. No compatible live rollback/recovery artifact has
been selected or installed by this implementation lane.

## Common forwarding boundary

The local App Server bridge and owner's runner relay use the same mutation
channel. The versioned `codex-launch` control helper supplies that channel for the
supported Desktop raw WebSocket proxy. The stable command-line-tools wrapper
delegates its complete original argv to the sealed helper; classification and
policy stay in Concierge. Native proxy stdio is a byte stream carrying WebSocket
handshake/frames, not JSON lines. The helper terminates that WebSocket locally and
gates decoded client messages before forwarding to the original native socket.
Server requests and read responses remain available.

The foreground runner relay contacts the common owner through the gateway's
existing private asynchronous transport, with a bounded authority response and
no retry. Node bridge endpoint discovery stays outside the storage-free gateway
dependency graph; the normal gateway isolation check enforces that separation.

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
| Managed hook requirements/helper installation | Existing deployment and Mac installer write hook configuration directly | Hook-relevant writes are not bound to the native frame fence; exact cold construction stays unproved |
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

### Legacy connection reconciliation

Future-path mediation and legacy retirement are separate phases. The old native
connection is not retroactively enrolled by a wrapper change. The required chain
is positive receiver gate closure for the exact daemon incarnation/connection,
then enqueue a canonical `thread/read` for the exact thread, then its successful
response. Native `Thread` serialization is shared across connections. That read
orders earlier same-key handlers, including one surviving cleanup timeout. It
does not finish native tasks those handlers admitted. Paginated item/turn lists
are concurrent and provide no handler barrier. Path-only resume uses a different
`ThreadPath` queue and requires separate coverage; successful full handler drain
is an alternative stronger witness for started handlers. See the pinned
[request scope mapping](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/app-server-protocol/src/protocol/common.rs).

The inspected already-running native receiver has no established externally
supported positive gate-close or successful-drain receipt. Its transport close
event is not acknowledged after processing; cleanup can time out, and a missing
timeout warning proves nothing. No source-only log addition can supply that fact
for an old running daemon. Native-assigned connection identity for the retained
old proxy also remains unknown. These are exact missing retirement facts, not
claims that canonical read is unavailable.

Retirement additionally preserves relevant sent/queued Desktop input custody,
differently keyed operations and still-active native work. The native queue can
drop closed-gate queued requests without creating an accepted-input record;
therefore empty later history cannot reconstruct or dismiss uncertain words.
The parent's exact-lifetime process watch wakes reconciliation only. No forced
disconnect, reset or restart is authorized. Until a supported positive cut and
custody witness exists, this phase refuses and no barrier is submitted. The
managed fence, original source input, all obligations and child lanes remain held.

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

The paginated native proof covers projected rows only. Pinned native
materialization can skip malformed, unknown or missing-ordinal records while
advancing its checkpoint; general response records and replacement model history
need not produce item rows. A terminal cursor is therefore insufficient original
acknowledgement/effect coverage. The source candidate now complements that
projection with a private source-prefix witness: after acquiring the exact-thread
fence, the isolated history worker re-derives the accepted snapshot and fence,
repeats projected native coverage through the real host App Server client, and
asks that App Server to `thread/read` the bound thread. It resolves the returned
JSONL path under the configured local Codex home, reads the complete newline-
terminated prefix, validates native turn boundaries/order/context and all records,
then rechecks owner controls, fence, native watermark and source revision before
returning. Only hashes, counts, exact native identities and spans enter the safe
witness; source path and physical custody remain private to the host.

The reader refuses remote runners and paths outside the configured Codex home;
legacy mode is not eligible for accepted-binding recovery, and inherited/forked
history lineage, rollback, malformed or partial lines, unknown records/events,
unmapped ordinals, unclassified metadata/sidecars, accepted user/tool/configuration
effects and incomplete native suffix coverage refuse. An owned resume can extend
the witness only when its retained accepted intent and active fence match and the
source prefix is byte-identical with exactly one newline-terminated
`thread_settings_applied` record for the bound thread/model/effort and the complete
prior settings snapshot. Relevant context and settings must preserve their full
authoritative prior baselines, including permissions, working directory, roots,
plugins and every supported field. Unknown native fields refuse. A world-state
patch needs a current full baseline and must reconstruct the identical state. Missing baselines and changed
or unassessed output usage refuse; cumulative usage from earlier product work is
not a new effect. Raw baseline payloads stay in worker memory and source custody;
the retained witness contains their hashes. Positive output in a later independent
compaction requires exact native response IDs from its `Compacted` record,
matching per-response/turn usage totals and typed `ContextCompaction` completion
inside the fully mapped effect-free span. Selected compaction or output refuses.
Unproven retained context, guardian, resource-origin and resume sidecars refuse;
the fixture does not certify arbitrary compaction bodies. The worker
returns refreshed custody privately; the canonical owner stores it in the
dedicated immutable source-checkpoint ledger, never an event, audit or public
reply. The bounded gate covers eighteen disposable custody fixtures, including these
source/checkpoint contracts. Actual target compatibility and installed eligibility
remain the designing session's separate observations. Plain
compaction can preserve prior projected items; no target effect is inferred from
a replacement-context user record. See the pinned
[materializer](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/thread-store/src/local/thread_history_materialization.rs)
and [canonical projection](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/app-server-protocol/src/protocol/thread_history_projection.rs).

The original-source decoder is pinned to rust-v0.162.0 commit
`c1382380de69521303b416720a52f42d51af6248`. Its witness binds the decoder/reducer
interpretation and event catalogue digest, separately from the unchanged digest
primitive. Source revalidation and owned-resume refresh reject older interpretations.
The interpretation also binds the official pinned response schema, its composed
shape interpreter version and the source
numeric representation policy. Nested response shapes use the pinned schema;
classification/warehouse fields omitted by that schema retain separate raw-shape
checks. Typed source fingerprints preserve numeric lexemes so JavaScript rounding
cannot equate distinct original/replacement payloads or world/settings states.
The catalogue recognizes all twelve rollout kinds, the response variants and alias,
and all event wire names. Known native forms with unsupported proof semantics have
specific refusals; recognition alone is never a neutral-effects allow.

Earlier known effects are preserved with original envelope and baseline references.
Communication markers pair only with the next physical AgentMessage; either trigger
value in the relevant interval refuses. Compaction clears world/context baselines,
and the witness identifies the reset and full/context records that re-establish them.
Multiple context records are valid when each preserves the frozen settings. Absent
replacement history is a legacy transformation, distinct from an empty replacement,
and remains unsupported in the relevant interval. Latest-reachable usage may belong
to earlier work; missing usage still proves nothing about effects.

Replacement payload equality cannot strip delivery/source/order metadata. Only
native absent/default harness equivalence is normalized. Exact historical envelopes
or unchanged static-configuration restamping need earlier source references; new
system/developer instructions refuse in either direct or replacement history.
Earlier nonempty retained checkpoints can be copied exactly; newly introduced or
changed verified facts still require original provenance. Producer compatibility
is separate from Astra/Medium: the current reader positively supports matching
recorded producer/consumer hashes and precisely refuses unproved compatibility.
Authoritative optional resume metadata is retained as state, never filled from a
future binding; unsupported relevant transitions refuse.

A semantic failure blocks proof permanently for that read. The same physical read
also runs an isolated diagnostic instance of the existing reducer. Fully validated
known settings/context/world drift advances its observed state, with exact
before/after record references and digests; known effects are listed separately.
Compaction resets and subsequent re-establishment remain explicit. The diagnostic
keeps the pre-selected baseline separate from its last successfully analyzed state.
It never chooses intended roots or explains their owner/resource cause.

Any unsupported shape, unknown record, missing provenance or inconsistent
dependency discards the diagnostic reducer permanently. Its last whole-record
commit remains visible; the failing record's partially updated state is never
published. All shared reconstruction dependencies are conservatively invalidated,
and the unassessed range extends through captured EOF. Later checkpoints cannot
repair that state. Physical decoding/inventory still covers the entire source.
The diagnostic currently supports complete disabled/external permission snapshots;
complex managed filesystem policies refuse rather than advance on a shallow shape.
Nested granular approval fields are checked against the pinned shape, including
its optional booleans; unknown fields cannot advance diagnostic state.

The separately typed result binds source identity/revision, captured EOF and
decoder/diagnostic interpretations. It carries only references, counts and digests,
has no witness/custody, and explicitly forbids provider start. Semantic completion
means diagnostic analysis reached EOF, including listed effects; it never means
strict proof succeeded. Witness revalidation, owned-resume refresh and dispatch
grant reject the diagnostic policy. There is no caller waiver or execution-consuming
reconciliation mode. This is diagnostic coverage, not recovery permission. The
[decoder incident](../incidents/2026-11-14-native-history-decoder-boundary.md) records
the original failure and remaining evidence boundaries. Durable rollout coverage
cannot establish absence of transient unpersisted effects; owner and fence proofs
remain independently required.

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
cold reconstruction/config evidence must be derived for the selected operation.
Historical `notLoaded` is not current eligibility.

Pinned native cold construction calls `Hooks::new` before `SessionConfigured` and
waits for that event before returning a successful resume. This permits proof by
construction when the exact cold request, enabled effective hook feature and
required managed handler/configuration are bound to that success. No new native
hook acknowledgement is intrinsically required. Separate cwd config/hooks reads
alone do not bind those inputs; a disabled hook feature even clears required-hook
load errors, and a warm resume reuses its existing runtime. The current candidate
now derives that binding as follows. The private history worker reads the exact
unloaded thread and exhausted loaded-thread listing, managed requirements and cwd
configuration twice under the exact fence. It requires the pinned required
managed handler and hooks feature constraint. The native configuration read
omits some stable features: absence of a hooks echo is not false. Actual resume
parameters independently require exactly `features.hooks=true` and Medium;
explicit contradictory configuration refuses. Immediately before forwarding the
worker recaptures the same target/configuration basis, allowing unrelated loaded
threads to change. The owner retains an immutable hash-only input fact bound to
the actual resume parameters. Raw settings remain transient.

The channel hashes the complete actual result before projecting safe response
fields. After resume the worker matches that hash to the retained exact intent,
validates returned thread/cwd/model/effort/source identities, and binds successful
cold construction through `SessionConfigured` to this resume. The owner retains an
immutable construction receipt and original-prefix settings checkpoint. Both are
required before the single actual start. Missing response, construction,
checkpoint or invocation cannot authorize another native attempt.
The supported installer writes the managed requirements and hook wrappers before
service restart. That is an actual configuration producer, not an administrator
bypass to dismiss. The requirements API has no generation token binding its read
to the later native config load. Construction proof therefore needs the existing
configuration writer brought under common-owner exclusion. Every supported hook
installer entry delegates to a supervisor that issues a global configuration
intent in the existing mutation ledger before its writing body starts. Active
fences and stopped fences with unresolved issued work conflict with that intent;
the intent blocks new mutations and reservations until its exact child completes
successfully. Failure/death does not release it in a trap or by expiry. Ordinary
unrelated continuing turns retain their existing custody. The scanner separately
refuses uncovered old installer and pending supported deployment producer
lifetimes; absence of a current writing child is insufficient. Server hook
installation follows offline additive migration while the service is stopped,
avoiding a new live-owner control dependency. Mac and host callers retain their
entry arguments. A generic read or caller boolean cannot supply this exclusion.

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
runner relay and raw WebSocket helper with independent clients and barriers. The
bounded continuation contract gate now includes original-source parsing and the
actual history worker, including a source-control change during a read. All twelve fixtures passed after source and fixture integration.
These prove source contracts. They do not prove installed selection, old native
handler drainage, current hook activation, target history custody, live delivery
or useful work. The production accepted-binding entry remains guarded until the
legacy positive receiver cut, cold hook configuration and target source witness
are all established for the installed machine. See the
[incident](../incidents/2026-11-13-writing-continuation-eligibility.md).
