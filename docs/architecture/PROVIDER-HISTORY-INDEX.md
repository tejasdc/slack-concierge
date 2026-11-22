# Bounded provider history reads

## History process retirement

The page projection runtime runs in one persistent Bun subprocess per service
generation, using the serving process's runtime and sealed application worker path.
It has a separate SQLite registry: history teardown cannot take the serving Bun
process's global SQLite lock. IPC carries correlated results or explicit errors;
lost acknowledgements never authorize provider invocation or manufacture empty history.

Closing seals admission synchronously and permanently, including warm-up, background
Codex preparation, timed-out work, and late replies. A timeout releases only its
waiting caller, never process ownership. An unexpected child exit seals this client
rather than starting another generation. Retirement signals the owned process group,
escalates termination after two seconds, and awaits child closure and the absence of
running group descendants (Linux excludes already exited zombies). The existing
service supervisor remains the outer crash-cleanup boundary.

Both service shutdown entrances stop queue dispatch and set the host's admission
fence synchronously before retiring history. New accepted requests remain queued;
the provider wrapper rechecks the fence after durability and all asynchronous
preparation, immediately before recording admission intent and invoking a provider.
Proven-unsent work keeps its exact input and returns to the queue; retained earlier
intent remains uncertain and is never turned into permission to replay. Adoption
and genuine Stop still follow their existing execution rather than starting another.
Both entrances retire history before setting general draining state,
closing request communication, or withdrawing turn custody. During that wait the old
service still accepts durable requests and provider results. Subsequent drain and
successor recovery retain their existing exact-input and provider-result contracts;
history retirement never requests a genuine Stop or retries an invocation.

A retirement rejection logs an explicit failure and continues the ordinary custody
drain with dispatch fenced. The helper reference is not discarded on that failure;
the supervised service's process group/cgroup remains the outer termination owner.
The later host stop uses the same failure continuation, so a rejected retirement
cannot strand shutdown before request closure or the final custody flush.

The history child explicitly sets `CONCIERGE_READ_WORKER=1`: ledger access opens a
physically read-only connection, enables query-only mode and skips schema writes.
The import child reads the native transcript, truncates only scratch segment copies,
builds a derived `.next.sqlite` transaction, closes it and atomically renames it over
the derived snapshot. The verification child opens both databases read-only and
publishes only generation-bound `.verified.json` via temporary-file rename.
Other projection writes are derived Codex windows/marks and runner transcript copies
with source-identity metadata. The ledger and native provider transcripts remain
authoritative and are not written by these paths. SIGKILL may abandon a temporary
file or interrupt a derived transaction/publication; it cannot interrupt an
authoritative request/result commit. SQLite rollback and atomic publication retain
the preceding snapshot, while missing verification is reconstructed from the import
position. Remote source copy/metadata mismatches remain explicit read failures.

`history-release-fence-fixture.ts` exercises actual claimed work through the execution
host, exact unsent requeue, retained-intent uncertainty, acceptance during retirement,
and injected retirement rejection; it runs in the package build chain.

Disposable verification: `bot/scripts/history-process-retirement-fixture.ts` checks
timeouts, monotonic closure, process exit and durable SQLite acceptance/readback during
a five-second synchronous helper teardown interrupted by the two-second escalation. Its one-second maximum write bound rejects
the observed multi-second stall while allowing shared-host fsync variance. The history
page growth fixture also exercises the real history subprocess. These checks do not
establish production release timing or exact active-turn continuity across an installed
release; those remain release acceptance observations.

Claude Code's native session reader follows the transcript graph and compaction rules. Concierge must not recreate those rules from raw JSONL or run that reader inside the single request owner.

That reader lists only what follows a conversation's latest compaction. A compaction never removes history: the import child finds each compaction boundary line and runs the same native reader on a scratch copy of the transcript as it stood just before that boundary, so each earlier part comes back under Claude Code's own rules, followed by the current part, de-duplicated by row identity. Before this, every compaction removed the whole earlier conversation from the session window and his requests from before it were drawn at the bottom (thnkr.ing report 60b1809c, 2026-10-29). Snapshots carry a format number (`provider-history-format.ts`); an older one keeps serving while the verifier child checks its transcript once, recording the current format when it never compacted and asking for one rebuild when it did. The import log line counts `compactions` and `rowsBeforeLatestCompaction`.

The first history request starts one serialized child import and returns `coverage.complete=false` with `history_indexing`. The child uses the native SDK, inserts queued human messages at their native positions, and atomically publishes a separate SQLite snapshot of ordered source rows, message identities, and tool names. It sends no transcript bytes over IPC. The release includes this worker beside the owner bundle. Imports have a 120-second deadline; a failed import is reported as `history_import_failed` with a retry interval. The old snapshot remains readable while a replacement builds.

Pages read only the requested ordinal range; tool detail reads one indexed row. The shared prepared message index separately tracks all owner message identities and immutable versions, including non-Inbox sessions. A bounded indexed anti-join selects live identities absent from the SDK baseline, and exact versions replace baseline identities without changing their position. Page cursors pin the SDK snapshot generation and retained-event sequence. A replacement invalidates old cursors, so the consumer must reset to the latest page. The import records the owner's message-event sequence *before* the child starts. Events written during import are therefore replayed by identity and coalesced instead of being lost. A live tool detail key names one exact retained event and is read from that event, even when it is absent from the SDK snapshot.

An append to Claude's file does not itself trigger another full import. A separate verifier child walks only bytes since its durable verified position and checks that every new visible message and tool result is represented by a retained owner event, and that the transcript remains an append of the same graph. This parsing never runs on the interactive owner. External writes, graph branches, compaction, truncation or missing retained messages make coverage incomplete and schedule one background import after the source stabilizes. The page continues serving the last snapshot and retained live messages while preparation runs. This is a freshness contract, not a promise that complex external history is instantly available.

Snapshots are prepared before anyone opens a conversation. The owner's history keeper (`provider-history-warmer.ts`, both compositions) checks once a minute for Claude conversations whose latest finished turn it has not prepared, skips any with a turn under way, and runs the same verification, then import if needed, one conversation at a time in the existing child processes; the first pass after a start covers every conversation. It logs `provider_history_warmed` per pass. Before it existed only 192 of the conversations had a snapshot, so most first opens answered with no messages while an import ran (2026-10-13). Each read executor also loads its history page worker at startup rather than on the first open.

The separate snapshot is derived data; the native transcript and owner event ledger remain authorities. Do not delete either as cache cleanup. Look for `provider_history_imported`, `provider_history_import_failed` and response `coverage` during investigation. A cold page's client must retry on `history_indexing` instead of presenting an empty conversation as complete. A newly created native conversation is different: before any first input, the retained creation is its only input, it has no turn and no provider binding. The owner can answer complete empty history from that ledger state without asking the provider history worker. The first accepted input changes the ledger and announces itself on the existing event stream; accepted but unbound input remains incomplete rather than disappearing into an empty answer. This avoids a one-second history poll throughout an idle Canvas conversation without weakening cold-history coverage.

## Object-backed cache maintenance

The importer continues to publish full SDK rows. The optional
[deployment-owned maintenance entrance](../runbooks/DEPLOYMENT.md#history-cache-maintenance)
can replace exact matching payloads with proven immutable object spans, after
backing up the precise closed cache inode and its generation-keyed verifier
sidecar to Restic and streaming back every byte. The sidecar is recorded inside
the private backup manifest; the backup certificate never uses the live
`.verified.json` filename. Old, synthetic, unmatched and ambiguous rows stay full.
Concierge owns its small-cache admission and Restic transfer controls; the host's
generic credential wrapper provides neither pacing nor an exclusion lease. The
maintenance runbook owns limits, observation, collision refusal and proof resumption.

Conversion preserves source path, cwd, ordinals, message identities, tool names,
and all SDK metadata. A fresh generation invalidates baseline cursors and detail
keys once; a matching verifier checkpoint moves to that generation. Retained
owner-event detail keys and overlays do not change. Before atomic publication,
the converter decodes every old and new row and compares their complete values,
metadata and both indexes. It keeps the old inode pinned until explicit release;
an interruption retains that recovery generation. Restic readback and complete
decoder equivalence are distinct from installed page/detail acceptance. The
runner mirror and Codex window remain intact.

Optional-maintenance failures retain their exact attempt and recovery evidence
without failing unrelated releases. Recovery reconciles the old, prepared and
published cache bytes and finishes only the corresponding operation. A separate
file-only release compatibility fence prevents an application or deployment
controller that cannot handle object references from being activated while any
session requires that format. Exact rollback and materialization clear a
requirement only after a reference-free cache is observed; capability metadata
in a hybrid release belongs to its respective application or controller source.

## Source history and archive evidence

- Claude history reads resolve the bound provider UUID through the SDK across project
  directories; current execution cwd is not transcript storage identity. Project a
  provider-observed steering message from its unique accepted input and exact retained
  replay bytes when Claude assigns a different row UUID; the JSON identity header is
  transport, not chat content or authority. A Claude user row is a message only when
  Claude records who submitted it (`promptSource` `sdk` from the owner, or `typed`).
  Interruption notes, model-switch records, background-task notifications, compaction
  notes and other CLI bookkeeping are never messages: in a session this owner drives,
  anything a person or another session said was submitted through the owner, so history
  drops a user row it cannot attribute and the live stream publishes one only when its
  text is exactly one the run wrote to Claude or a person typed it. Claude marks queued
  notifications as replays too, so the replay flag proves nothing (2026-09-21). Claude records a
  message without its trailing whitespace, so the input envelope sends that form; exact sent bytes
  with a trailing space hid an answered reply as Queued (2026-10-22). Imported and reconstructed sessions
  keep their unattributable rows. Decide by that recorded author, never by wording: matching one
  interruption phrasing missed the next, and real messages can start with a bracket.
  A turn's opening input is proved the same way and must not wait for the provider to
  echo it: the transcript can show the message first, which rendered it as an unknown
  author with its header as text. Only header-stamped bytes are unique by construction,
  so ambiguous or headerless bytes fall through to the older joins. A delegated message
  shows its whole chain — sender, the human request it acts for, and work versus
  information — never less than its operation receipt already resolves.

- Archive discovery retains exact source bytes through the source capability before
  materializing a returned catalogue candidate. Pure index searches do not copy archives;
  changed or unavailable candidates remain explicit coverage omissions. The retention proof
  is one page of Thinkering's prepared history for that exact version (`retainArchiveSource`),
  never a `context` read: context re-reads and serializes the whole snapshot on every search,
  and a 289 MB transcript cost 5.8 s and 120 MB per candidate, making one search take 10.2 s
  (supervisor incident 708b0814, 2026-10-08).

- Source history is cited evidence. Verify exact source/version/branch/event membership.
  Catalogue projections distinguish unbound imported `historical-evidence` from
  conversations; discovery never promotes evidence into active work. Reconstructed
  consultations and explicitly bound imports remain conversations. The wire contract
  owns the classification and backward-compatible surface rule.
  An imported Claude/Codex source with a native UUID may continue through resurrection
  on the machine holding its recorded folder and provider transcript. The owning machine
  binds one native session to that UUID; peer archive resurrection still makes a distinct copy.
  Historical consultation is information-only, with no tools, network, writes or outbound
  requests. Preserve the source and the restricted child identity across follow-ups.
