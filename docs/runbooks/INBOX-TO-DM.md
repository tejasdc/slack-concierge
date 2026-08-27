# Inbox to Concierge DM: cutover handoff

## Authority and current boundary

Tejas authorized the complete migration in DM turn 553 and Concierge turn 556.
The complete reviewed scope is the locally committed
[`concierge-dm` plan](/root/workspace/concierge-dm/docs/plans/2026-08-26-inbox-to-dm.md).
The DM repository intentionally has no remote. Its canonical `AGENTS.md` and
`docs/router-lessons.md` already import the validated routing contract while
preserving ordinary conversation and no unsolicited report attachments.

**The runtime cutover was rolled back after live acceptance.** Activation proved
the shared Claude anchor, source and steering identity, routing outcomes, exact
file forwarding, native Slack voice, real Pebble delivery, a fresh Monologue
note plus deduplication, and the existing List/Canvas. The retirement drain then
found eight older Pebble events whose Slack delivery had succeeded but whose
downstream turns had been cancelled before provider dispatch. The old inbox was
therefore not archived. Future Pebble/Monologue routing and the DM provider
defaults were restored to their pre-cutover values while all accepted events,
Slack history, provider/session rows, imported notes, and Monologue seen IDs
were preserved.

Implementation coordination: Concierge `C0BNN5K4JSJ`, migration root
`1787728395.575119`. Source-context restoration from helper root
`1787712481.791679` is integrated and live. Monologue is owned by remote-box
`C0BN9EXRB0F`, root `1787728476.445999`; its destination change was exercised
during acceptance, is now rolled back, and must remain unactivated until the
retirement blocker is resolved.

## Exact retirement blocker

The final joined capture/input/turn audit found these delivered old-destination
Pebble events with terminal `cancelled / not_ready` turns and provider reason
`Session is already running another provider turn.`:

- `95ab31da5476afc1a4068fb7fbe07a22748e869f1737dd307bc7776cad631b03` — Slack `1787196473.317689`, turn 311
- `c9135dac859a4d6cb027138662770fa6f0c00c653c86da5551b8465a726153a7` — Slack `1787247859.658079`, turn 337
- `d76f6124d5dee46b1379dc57a6b2bf81e6819a95f6d0fefa1e5fdc354d787dc7` — Slack `1787250296.685409`, turn 345
- `54a8f7731348ac0cde18afd0f2cc8119235405f618b283c087590662d9786eb3` — Slack `1787253484.164319`, turn 353
- `9ae954eda9eb95da722bf81267571d152c30c86d35c4b9f220c8e540fd3be89a` — Slack `1787362229.264429`, turn 379
- `d6caa4e99aa9237079863402da25dc411c72eb4daf6e757c32e695f2cd5cbc33` — Slack `1787419904.024089`, turn 381
- `fd7f6e97869f2b53fdf61f189841eb345f8d3972b282c1a1cf716bdbfe96f876` — Slack `1787419910.522229`, turn 382
- `78bacd09e27fda797c132948e9ea4854a919f01c55189e3a2e4af07ab1f218f1` — Slack `1787545983.744949`, turn 392

All eight were durably accepted and claimed, but none has a provider start or
downstream delivery receipt. They predate this migration and expose the former
single-session contention failure, but the reviewed cutover contract expressly
forbids treating Slack delivery alone as completion. Do not replay these
delivered events or silently waive them. Keep `#slack-inbox` active until Tejas
chooses how to reconcile this historical work or explicitly accepts retirement
with the known loss surfaced.

Keep the old inbox active and unarchived while any blocker or ambiguous accepted
delivery remains. These are blockers to completing the authorized request, not
a redefinition of completion as “pushed.”

## Live acceptance and rollback evidence, 2026-08-26

- Concierge acceptance ran on deployed `2d2658e`; the upload reservation fix was
  independently reviewed `SHIP`, and the full gate passed before activation.
- DM roots and an old historical root reused new Claude UUID
  `63cbc007-308c-4bfa-a8c8-55996cedb9b1`; multiple steering inputs preserved
  their exact Slack identities and FIFO order.
- Exact original-file forwarding, correction/resume, split routing, passive
  TODO, ambiguity, noise, general chat, and status research all passed with
  verified receipts.
- Native Slack audio `F0BSXVA504E` transcribed and answered in the same shared
  context. Real Pebble event `7f33c0c7…92590` delivered once to the DM. Fresh
  Monologue IDs `19d936e6…028b` and `907fa72d…b2ec` were preserved, and the next
  timer poll posted no duplicate. The seen file remains 42 lines with SHA-256
  `31dcf990a54970df2461d430cc7deb2ac6df8e9ed6ab3e74688f7bd307f53b02`.
- Tejas confirmed the List; authenticated Canvas lookup found the canonical
  `Concierge DM`, `Working directory`, and `Slack response contract` sections.
- Retirement discovery guard `ace95d6` received an independent `SHIP` verdict,
  passed 111 focused tests, and deployed successfully before the drain.
- Rollback commits are Concierge `d045a4b` and remote-box `43cde0f`. Concierge
  deployment run `58701e33-2999-4123-a52f-e29463db38e7` proved exact runtime
  `d045a4b`, functional capture/service health, and released gates. The DM is
  again `codex` / `per-thread` with no default UUID; the old inbox remains
  `agent-auto` / `claude-code` / `single-persistent` and unarchived. Pebble and
  Monologue defaults again target `C0BNNP6U6GN`.

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

## Remaining cutover work and ownership

The migration owner must resume from the same authorized scope, with a real
operator/continuation established before mutating runtime. No new service,
credential, poller, mapping table, memory platform, or success-wake is implied.

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
