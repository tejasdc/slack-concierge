# Concierge history payload retirement against retained transcript objects

Status: implementation design; no cache row or runner mirror is retired before the
host object store and its exact Restic restore proof are installed and checked.

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
   `type`, `uuid`, `sessionId`, and `message` match the SDK row exactly at import,
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

The host object is the one home for raw bytes; Concierge keeps only the SDK delta
that the raw version cannot represent. The owner-event overlay remains the home
for post-import accepted messages and their latest versions. A host object is
never inferred from a pathname alone. Its catalogue and proof must name the
digest and retained version explicitly. No object is garbage collected while a
snapshot refers to it.

An older row may be absent from the current provider file after a rewrite or
compaction. The migration considers every proven version catalogued for that exact
source path, newest first, and accepts a span only after exact row comparison.
Versions are never chosen by UUID alone. Unmatched rows keep their full payload.

## Runner mirror and Codex boundary

The runner owns provider homes. Concierge's current mirror under its private
state is an import cache, not authority. A page read must first compare bounded
runner metadata with the snapshot; it must not copy the entire remote transcript
merely to decide that an unchanged snapshot is current. When an import is needed,
the SDK reads the exact immutable object through a temporary project tree if it
covers the source version. Otherwise it uses the existing runner transfer and
keeps that mirror until a proven object covers it. Temporary files are removed
only after the import has published its snapshot. Old snapshots keep serving
through an interrupted import.

The Codex window is App Server output with provider timestamps and continuation
markers. Its rows cannot use Claude's raw-line matcher. Keep that window until a
separate Codex identity, page, timestamp, and detail equivalence proof establishes
which payloads are reconstructible from a retained object. This decision leaves
the measured 0.30 GB Codex window unchanged for now rather than guessing.

## Cutover and falsifying checks

Build the candidate in an isolated worktree. The importer first writes a new
snapshot format with existing full rows and candidate references, preserving old
snapshot readability. The comparator walks a complete old and new conversation:
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

After host install, one guarded migration can publish only verified reference
rows atomically and retire only the superseded full-row payloads. A rollback
reads the retained object and reconstructs the old snapshot before downgrading
the application; object GC remains disabled. Concierge's ordinary deployment
path, independent runtime review, and installed page/detail reads are required
before reporting a user-visible or space result. The installed release and raw
object restore proof are distinct evidence.

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

Concierge needs a machine-readable lookup from complete source SHA-256 to the
exact immutable object and a proof receipt for that digest and named Restic
snapshot, plus an exact restore-by-digest operation after local loss. The host
owner is finishing the object/proof contract; no source inspection of a draft
plan is installation evidence.
