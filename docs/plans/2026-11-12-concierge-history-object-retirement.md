# Concierge history payload retirement against retained transcript objects

Status: reader, read-only allocation inventory, and stopped-service operator
converter are committed. Automatic new-import conversion has been removed: it
could replace a cache before a separately verified product backup existed. No
live cache row or runner mirror has been retired. The host object store and
restore command are installed, but Concierge's private cache backup, owner-side
measurement, and page/detail acceptance remain separate gates.

## Requirement and current owners

The request is to reduce duplicate agent-history payloads on AX41 while keeping
Sessions ordering, old pages, detail reads, and history after a provider file
disappears. The raw provider transcript remains in its account home on the runner.
The host owns write-once digest-named retained versions and offsite restore proof.
Concierge owns its private runner-source mirror, Claude SDK history snapshot, Codex
window, and owner-event overlay. `presentation.db` is a ledger projection, outside
this migration.

The older offset-only proposal fails because a provider file can disappear while
the snapshot still serves, and the SDK returns normalized rows. Queued prompts are
synthetic rows assembled from attachment records. A byte offset by itself neither
recreates those rows nor protects them from source replacement. The current runner
mirror is reused across reads; the source has no after-import removal path.

## Row invariant

Each snapshot keeps the SDK's ordinal, UUID, message/tool indexes, and version.
For every row, exactly one of these can serve its complete SDK value:

1. A full stored row (the existing format). This is mandatory for synthetic,
   unmatched, ambiguous, or not-yet-proven rows.
2. SDK metadata plus a span of one immutable host object, only when the raw line's
   `type`, `uuid`, `sessionId`, and present `message` match the SDK row exactly at import,
   the complete object digest and length match, and that exact object has successful offsite
   restore/readback proof. The span holds byte offset, length, and line digest.

The decoder checks the span and digest, reads the raw `message`, and combines it
with stored SDK metadata. If the referenced object is unavailable or changed, it
never substitutes the current provider file or a same-UUID row from another
version. Full rows remain until an exact host restore-by-digest path can recover
the object when local bytes vanish, and installed page/detail comparison and
offsite proof have passed. A proof of a past restore alone is not a live recovery
path. Before those conditions, format changes may be published with full rows but
no payload retirement.

Recovery must stage an exact object privately, check its raw digest and byte
length, and exclusively publish a missing object; it must refuse to overwrite
an existing corrupt inode. Because the snapshot named in an old proof may age
out under backup retention, recovery also needs a verified later snapshot
containing the same immutable object path, or it must refuse and preserve the
full-row fallback. The host installed this as an operator command in its
object-store delivery and exercised a disposable 63-byte offsite restore and
healthy no-op. That probe does not prove custody for any production transcript.

The host object is the one home for raw bytes; Concierge keeps only the SDK delta
that the raw version cannot represent. The owner-event overlay remains the home
for post-import accepted messages and their latest versions. A host object is
never inferred from a pathname alone. Its catalogue and proof must name the
digest and retained version explicitly. No object is garbage collected while a
snapshot refers to it.

The runner relay deliberately does not disclose provider-home paths. Concierge
therefore identifies a candidate host object by hashing the complete, exact
runner bytes it received. It must not derive a catalogue key from its private
mirror pathname or guess the original provider path. The digest-named host object
is usable only after its bytes, length, and separate offsite proof agree with
that digest. The host's path catalogue can establish version provenance for an
operator, but it cannot substitute for content verification at the reader.

An older row may be absent from the current provider file after a rewrite or
compaction. The migration considers only exact retained versions whose original
runner and account identity is independently established; the private mirror
pathname cannot establish that identity for host catalogue lookup. Until such a
mapping exists, historical rows that cannot match the current verified object
keep their full payload. Versions are never chosen by UUID alone.

## Exact mapping from runner bytes to a retained object

The current runner relay returns an account-scoped source fingerprint from file
identity and timestamps, plus size and mtime; it does not return a byte digest or
provider-home path. Concierge keeps that fingerprint with its stable mirror key
(`runner`, `account`, session UUID and cwd). After a complete pinned relay transfer,
it hashes the mirror's exact bytes and records the complete digest and byte count
with that runner version. The host object can be selected only by this content
digest and only after its plan-bound proof and bytes validate. A matching digest
does not replace the runner/account/native identity: those remain in the cache
metadata and determine which snapshot is served.

If the archive has not yet captured that exact version, or the provider changes
during transfer, the importer writes full SDK rows and leaves the mirror intact.
A later proven version can be considered by a guarded migration; it never
substitutes a newer provider file for an older snapshot row. For rows created by
compaction-prefix SDK reads or by queued-message synthesis, the exact raw line
and SDK message still have to match; otherwise the full row is the only form.

## Runner mirror and Codex boundary

The runner owns provider homes. Concierge's current mirror under its private
state is an import cache, not authority. Its stable path, size and mtime are
part of the current snapshot identity. Page reads use that path to verify new
source bytes incrementally, and the Claude SDK reads a local config tree during
import. The compaction reader also needs local, seekable bytes to make and
truncate one temporary prefix. An object reference cannot simply remove the
mirror: a missing or moved path triggers a re-import, and an append without the
mirror would require a full runner transfer in bounded relay chunks.

The row-payload cutover therefore keeps the mirror until a separate, installed
source adapter can preserve a stable local SDK path and incremental verification
against exact retained versions. A page read must compare bounded runner metadata
with the snapshot without downloading the entire transcript when unchanged.
When an import is needed, the SDK can read an exact immutable object through a
temporary project tree if that object covers the runner version; otherwise it
uses the existing runner transfer. The import child has a 120-second deadline
and one serialized lane, so any object lookup or transfer needed by the child
must be assessed against that bound. Old snapshots keep serving through an
interrupted import.

The snapshot's generation pins cursors and detail keys. Rebuilding it for a
format change invalidates an open cursor once; clients must reset to the latest
page. The reader must retain `message_ids`, `tool_names`, ordinals and UUIDs
exactly, since the accepted-message overlay joins against those IDs and detail
reads resolve through the stored row. A reference expansion must return the
same complete SDK value before the existing page/detail translators run.

The candidate storage format keeps the existing SQLite row and indexes and
places either the full SDK JSON or a tagged object reference in its `json`
column. The tag carries the object digest and length, bounded raw-line span and
line digest, and all SDK metadata except the exact raw `message`. One decoder
expands both forms before page, selected-message or tool-detail translation.
This avoids a second index but means an older Concierge binary cannot read a
tagged row. The cutover must supply and exercise an exact materialization path
that restores full SDK JSON before downgrade; until then no tagged row may be
written to live state.

The isolated operator conversion copies one SQLite snapshot, requires both
Concierge and the server backup service to be stopped, checks space for the copy,
and scans only the unchanged local source version named by that snapshot. It
queries SDK rows by UUID, rejects duplicate raw UUIDs and oversized lines,
compares raw and SDK message values, and verifies the complete host object and
plan-bound proof before replacing any row JSON. Unmatched rows stay full. A
successful conversion checks the copied database and atomically replaces one
snapshot; a no-match result leaves the original inode untouched. The inverse
operator command expands every tagged row into complete SDK JSON before an
older release is installed. Neither command is run during the active product
backup or against a cache whose source changed.

The Codex window is App Server output with provider timestamps and continuation
markers. Its rows cannot use Claude's raw-line matcher. Keep that window until a
separate Codex identity, page, timestamp, and detail equivalence proof establishes
which payloads are reconstructible from a retained object. This decision leaves
the measured 0.30 GB Codex window unchanged for now rather than guessing.

## Cutover and falsifying checks

Build the candidate in an isolated worktree. The importer still writes full
rows; a separate guarded conversion replaces only exact proven rows in one
snapshot after import. The comparator walks a complete old and new conversation:
newest page, older cursor pages, compaction boundaries, queued prompts, tool
details, owner-event replacements, missing provider files, runner identity, and
object corruption/missing cases. No sample-only comparison authorizes retirement.
It measures actual allocated bytes before and after, including the mirror, and
reports the row counts in reference and fallback forms. A comparison or proof
failure leaves the old snapshot and mirror intact.

Object matching scans raw lines once with bounded memory and looks up candidate
SDK rows through the snapshot's UUID index. It never loads a whole large
conversation's parsed rows into the migration process. Duplicate UUIDs, oversized
or incomplete lines, and any SDK/raw message mismatch keep full rows.

After host install, a conversion may publish only verified reference rows
atomically and retire only the superseded full-row payloads. The importer always
writes full rows. The stopped-service operator command is packaged with the
sealed release; it can materialize full rows before an older binary is
installed. The command is not yet an activation path: a product-owned, consistent
backup of the exact cache generation and its retained object dependencies must
be captured and restored or read back before replacement. The deployment
controller's existing ledger backup does not include these cache files, and a
whole-machine snapshot of a running owner does not establish a consistent cache
cut. This backup must be bounded, tied to the cache generation, and recoverable
without reading the live provider file. A rollback reads the retained object
and reconstructs the old snapshot before downgrading the application; object GC
remains disabled. A repeated conversion can add newly proven rows while
preserving earlier references. Concierge's ordinary deployment path, owner
self-review, and installed page/detail reads are required before reporting a
user-visible or space result. The installed release and raw object restore
proof are distinct evidence.

The bounded backup boundary is one stopped-owner snapshot at a time. Since the
importer writes a new SQLite file and renames it over the prior snapshot, the
stopped snapshot inode is closed and stable. A private hard link can pin that
exact generation without allocating another local payload copy. A targeted
offsite snapshot must include that pinned file, identify its full snapshot ID,
and read back its complete bytes and SQLite integrity from the named snapshot.
Only then may conversion replace the live pathname. Keep the pin until the
replacement has been read back through the same page/detail decoder; a crash
leaves the previous generation available for recovery. Once it is safely
retired, count the old inode's allocated blocks as released only if that pin
was its last local link. The offsite receipt must name the exact pre-conversion
generation, digest, byte count, and immutable object digests used by the new
generation. A failed or ambiguous backup cannot authorize conversion.

This uses the existing Restic repository and the deployment controller's
stopped-owner interval; it adds no timer, credential, or long-lived service.
An in-place SQLite backup would allocate another local payload copy and risk
reading a live owner; an ordinary nightly whole-machine snapshot gives neither
an exact application cut nor complete readback. The hard link plus targeted
readback is therefore the candidate for this product, subject to measured
runtime and disk impact before activation. It is a design, not an installed
backup command or a completed product proof.

## Decision case

The objective is allocated-byte reduction with unchanged Sessions behavior and
recovery. Keeping full rows wins on immediate availability and rollback and saves
no cache bytes. Compressing full rows could save bytes without a new custody
dependency, but still stores another complete copy of their content and adds
decompression to every page/detail read; its benefit is unmeasured here. Selective
references can remove payload bytes already held by the host object while keeping
SDK metadata, but depend on proof, restore, and a new reader. No option is ranked
by an unmeasured estimate. The migration report must show actual referenced and
fallback rows, baseline and final allocated bytes, and page/detail latency before
choosing whether reference retirement is worth its ongoing maintenance.

## Missing host interface

The installed host layout names each object by the complete raw SHA-256 at
`/root/transcript-objects/sha256/<first two hex digits>/<digest>`, with a
per-path version catalogue under `/root/transcript-objects/catalog/by-path/`.
The catalogue is a finder and does not prove bytes. The installed per-object
finder is `proofs/by-object/<digest>.json` with schema, digest, byte length,
full Restic snapshot ID, verification time, plan UUID, and exact canonical
plan digest. A consumer must bind this finder to the plan proof and backup
receipt and independently hash the object; parsing the finder is insufficient.
The installed host recovery command restores a missing digest from its named
snapshot or an operator-selected verified later one. The first production plan
proved five exact objects (488,160 logical bytes) with a separate Restic snapshot
and converted five archive links. Archive blocks released and new object blocks
allocated were both 495,616, so that batch saved zero host payload blocks.
Further host rollout is in progress. This host proof alone does not qualify any
Concierge cache row: its local source version, SDK equality, product backup,
installed page/detail readback, and allocated-byte delta still need checking.
