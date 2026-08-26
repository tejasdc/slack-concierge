# Inbox to Concierge DM: cutover handoff

## Authority and current boundary

Tejas authorized the complete migration in DM turn 553 and Concierge turn 556.
The complete reviewed scope is the locally committed
[`concierge-dm` plan](/root/workspace/concierge-dm/docs/plans/2026-08-26-inbox-to-dm.md).
The DM repository intentionally has no remote. Its canonical `AGENTS.md` and
`docs/router-lessons.md` already import the validated routing contract while
preserving ordinary conversation and no unsolicited report attachments.

**The cutover is in attended acceptance.** Shared-mode routing and source-input
identity are integrated. The canonical Pebble route targets the DM and becomes
live only through the normal `origin/main` deployment owner. A first activation
proved the shared Claude anchor across new and historical roots, restart-safe
reuse, native activity, and multiple steering identities. A file-forwarding
smoke then failed before Slack created a message or file share, so the operator
restored DM settings and both capture destinations to the old inbox. The narrow
upload-reservation encoding correction received an independent `SHIP` verdict
before reactivation. Keep the old router/channel operational and unarchived
until every remaining acceptance and final drain check passes.

Implementation coordination: Concierge `C0BNN5K4JSJ`, migration root
`1787728395.575119`. Source-context restoration remains owned by existing helper
root `1787712481.791679`; its initial/steering implementation must be integrated
and verified, not inferred from `trigger` success. Monologue is owned by
remote-box `C0BN9EXRB0F`, root `1787728476.445999`; its prepared destination
change must remain unactivated until shared DM readiness is established.

## Remaining real-device boundaries

1. Remote-box turn 557 found 40 real Monologue recordings, all already seen.
   Installed Monologue 0.2.0 exposes `list`, `all`, and `get`, not creation.
   A fresh device recording is required for fresh-note acceptance. Replaying a
   processed note or clearing the seen set would violate the acceptance test.
2. No fresh native Slack voice note or device-owned Shortcut configuration has
   been exercised for the migration. Text fixtures or a synthetic upload cannot
   establish those device surfaces. Record them as unverified, not unsupported.

Keep the old inbox active and unarchived while any blocker or ambiguous accepted
delivery remains. These are blockers to completing the authorized request, not
a redefinition of completion as “pushed.”

## Verified preflight, 2026-08-26

- DM `D0BMWUJ3RD5`: `agent-auto`, `codex`, `per-thread`, null default UUID;
  four ordinary Codex session rows, no fork parent, IDs 1003/1024/1059/1060.
- Old inbox `C0BNNP6U6GN`: `agent-auto`, bare `claude-code`,
  `single-persistent`, default UUID `6dcd7263-9f5c-4d5e-a2b2-783a46b6c820`.
  This is the one current router, not fragmented historical sessions.
- Existing DM Canvas `F0BSMKEHSMB` and List `F0BSA0V9BPZ` remain registered;
  List read-access state is retained. Live rendered contents/access were not
  re-proven by this preflight.
- Source inbox has three open TODO rows with full continuation paragraphs;
  target TODO file and both inbox-note files are header-only. Preserve the
  obsolete third TODO verbatim as user capture, not as current router guidance.
- Capture SQLite had 31 old-destination events, all `delivered`, and zero
  pending/sending/parked old-destination rows at the observation. Delivery is
  not proof that every router/downstream action completed; re-read at retirement.
- Installed helper `trigger 556` confirmed this turn's original source message
  and root. It does not identify later steering.
- Remote-box reports its one-minute timer active, last invocation successful,
  no destination override. Preserve its seen-file identity and stable IDs.
- A private, hash-verified preflight snapshot is under
  `/root/.local/state/concierge/backups/inbox-to-dm-20260826T214509Z` (0700).
  It contains only affected rows/identities and files, not credentials or a
  whole-database restore. All three imported TODOs and their continuation prose
  now exist in the DM canonical file and List; the old source remains untouched.
- The installed helper resolved the exact DM root `1787719226.227809` and
  reply `1787727805.333449` to the same root, and rejected an unknown timestamp
  with `message_not_found` / `delivery: not_sent` and no guessed destination.

## Remaining cutover work and ownership

The attended migration owner must continue in the same authorized scope. No new
service, credential, poller, mapping table, memory platform, or success-wake is
implied.

At the supported idle boundary, re-read both repositories and registry; prove
DM/inbox turns, queues, steering and in-flight Monologue work settled. Preserve a
targeted private snapshot of affected channel settings/session mappings,
canonical instructions/notes, capture configuration, Monologue configuration
and seen identity, with exact Git provenance. Do not restore the whole live DB
as rollback and do not copy provider transcripts into another session.

Set only the DM's runtime target: same ID and paths, `agent-auto`, bare
`claude-code`, `single-persistent`, a **new** shared anchor. Leave all old
session/turn IDs, UUIDs, reply timestamps and source-message lookup unchanged.
Do not reuse the old inbox provider UUID. Preserve explicit fork/comparison
requests and lineage. Mode changes cannot reassign already accepted work.

Merge inbox-local notes/TODOs into the current DM canonical files at that
boundary, preserving target content, order, status, all continuation prose and
original capture provenance. Strip only transient `Rec…` projection comments
from imported rows. Keep the existing DM List/Canvas and their permissions.
Preserve old source files as history; do not replay tasks or move project-owned
TODOs. The projector must prove full text, a fresh capture, and edit/completion.

Retarget `/pebble` only through `config/capture-routes.toml` and the normal
Concierge Git/deployment owner. Keep URL/authentication/event IDs, user-token
delivery, `/audio`, and `/var/agent-inbox` unchanged. Events accepted earlier
retain their original destination and must finish routing there. Remote-box
owns its canonical Monologue default change and `scripts/deploy.sh`; preserve
timer, processed IDs and any invocation already using the old destination.
Never deploy the Monologue branch merely because its tests passed.

The authorized plan's complete acceptance matrix remains mandatory: shared
Claude identity across two roots and an old-root reply after recovery, FIFO,
correct visible replies and per-input initial/steering identity, routing/resume/
correction/split/passive TODO/ambiguity/noise/general chat/status, original-file
forwarding with exact receipt, live Pebble and fresh Monologue with duplicate
checks, native Slack audio, List/Canvas/access, and fork/compare/project parity.
Use focused fixtures where allowed; label real smoke input and do not launch
fake implementation tasks. Record exact commits, provider/release/invocation
identity, event IDs, and helper-supplied permalinks. No synthetic test may be
reported as a real device recording.

## Retirement and rollback

After every required acceptance passes, enumerate active ingress, unsettled
captures, claims, queued/parked work, steering, and downstream receipts again.
Only a verified idle boundary may post the retirement pointer, archive (never
delete) the old channel, mark its registry silent, and remove it from active
routing discovery while retaining searchable history. A racing input defers
retirement; never silently discard it by switching to silent first.

If acceptance fails, keep the channel unarchived and restore only this
migration's future-routing/settings changes through their canonical owners.
Reconcile accepted event destinations before returning new intake to the old
channel. Preserve seen IDs, pending records, delivered receipts, source files,
and both histories. If already archived, unarchive before routing there again.
Do not restart the shared Codex App Server as part of cutover or rollback.
