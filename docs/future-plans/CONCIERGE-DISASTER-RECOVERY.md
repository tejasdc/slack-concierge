---
title: Concierge disaster recovery
status: future-proposal
owner: Slack Concierge and remote-box
---

# Concierge disaster recovery

This is a self-contained future project. Reading the archived platform-hardening
exploration is not required to understand, review, or implement it.

## Outcome

Define an explicit recovery objective and make a disaster restore produce one
coherent Concierge generation without blindly repeating Slack messages,
provider work, filesystem mutations, Slack Lists/Canvases, or Git effects.

Restic remains the storage transport. Slack Concierge owns application-consistent
snapshot and restore semantics; `remote-box` owns scheduling, immutable backup
execution, restic selection, retention, and the operator runbook.

## Scope

- Coherent snapshots of the main Concierge database, capture database,
  operations/control database, and provider continuity state.
- A generation catalog with immutable manifests and explicit lifecycle states.
- Exclusion of raw live SQLite/WAL/SHM files and live credential stores from
  ordinary whole-machine restore input.
- Durable backup retry and overdue-health reporting.
- An offline, journaled restore that survives interruption at every file and
  service transition.
- Reconciliation of restored external-effect intents against affirmative
  evidence before normal workers resume.
- Explicit post-restore source epochs/cutoffs for Pebble and Monologue.

This project does not promise restoration of OAuth credentials. Supported
re-authentication is a prerequisite after disaster recovery.

## Ownership and artifacts

| Artifact or action | Owner |
| --- | --- |
| Application snapshot/restore CLI and schemas | Slack Concierge |
| Snapshot gates across main/capture/provider writers | Slack Concierge |
| Backup timer, immutable driver, restic binary, selection, upload, retention | `remote-box` |
| Generation catalog and immutable generation directories | Root control plane |
| Fixed-path restore journal and terminal audits | Root restore driver |
| External Slack/provider/source reconciliation | Restore-only Concierge entrypoint |

The proposed local storage root is `/var/backups/concierge`, containing a
closed, fsynced catalog and immutable `generation-<id>` directories. A
generation contains standalone SQLite images, provider-state inventory/bundle,
release/config/schema digests, and a self-digesting manifest. Staging,
quarantine, restore quarantine, rollback, and audit slots are separately
bounded and never selected as normal backup input.

## Snapshot contract

- Claim one durable operations inhibitor before closing any runtime gate.
- Acquire gates in one order: operations inhibitor, bot admission,
  provider-state fence, capture snapshot gate, main external-effect gate.
- Wait for existing owners and provider children to become terminal; never
  infer a stable provider home while a writer can still mutate it.
- Copy each SQLite store through a pinned Online Backup implementation into a
  standalone image; verify integrity and absence of sidecars.
- Write and fsync the immutable generation before moving the catalog's `ready`
  pointer.
- Release gates in reverse order under the same operation token.
- Allow dead-owner adoption only after exact PID/boot/start identity proves the
  prior owner dead; adoption keeps the same generation and paths.

The snapshot helper, Bun/runtime closure, external tools, and backup driver are
content-addressed release artifacts. Mutable checkouts cannot authorize a
durable backup transition.

## Restore contract

- Restore begins by exclusively creating one root-owned fixed-path journal
  outside every database it may replace.
- Put public capture into maintenance and durably inhibit normal Concierge,
  capture, provider, Monologue, and backup work.
- Select one restic snapshot and one catalog revision; every later read must use
  that exact snapshot and manifest digest.
- Restore into bounded staging, validate complete membership and digests, and
  reject unknown SQLite sidecars or incomplete file sets before mutation.
- Journal each move/install/verify intent and result with fsync+rename so a new
  process can resume after any crash.
- Install main, capture, operations, and provider state as one acceptance unit.
- Start a sealed restore-only Concierge mode with ordinary Socket dispatch and
  side-effect workers disabled.
- Classify every nonterminal restored effect as proven terminal, safely
  recoverable, or `restored_review`; absence from an old snapshot is never
  positive proof that an external action did not happen.
- Establish Slack/source cutoff evidence, rotate Pebble/Monologue source epochs,
  create a fresh coherent generation, and prove a fresh normal bot invocation
  before releasing holds.
- Rename the fixed restore journal into a bounded terminal audit as the final
  mutation.

## Phased plan

### 1. Choose the recovery promise

- Select recovery point and recovery time objectives.
- Decide which external effects must be automatically replay-safe and which may
  require operator review.
- Inventory every effect family: Slack messages/status/reactions, provider
  starts, files, Lists, Canvas, channel/project creation, local/remote Git,
  capture, and Monologue.

### 2. Build coherent local generations

- Add the operations inhibitor and fixed snapshot gate ordering.
- Build/pin the SQLite Online Backup helper.
- Define the catalog, manifest, provider-state inventory, bounds, and
  self-digest format with golden vectors.
- Prove hot-WAL copying, concurrent writers, timeouts, interruption, adoption,
  and standalone restore in focused tests.

### 3. Coordinate `remote-box`

- Quiesce the current backup installation without killing an active backup.
- Deploy an immutable backup release that excludes raw live application state
  and selects only catalog-authorized generations.
- Add durable upload retry, pruning bounds, and a concrete overdue alert/failed
  health latch.
- Restore an ordinary successful restic snapshot into scratch as a release
  qualification gate.

### 4. Implement offline restore and reconciliation

- Add the external fixed-path restore journal and bounded quarantine/audit
  locations.
- Implement exact restic listing/dump, staging validation, journaled file-set
  replacement, and dead-owner recovery.
- Add restore-only startup and the exhaustive effect disposition registry.
- Add post-restore Slack/source cutoffs and credential re-authentication steps.

### 5. Rehearse and adopt

- Run a complete restore drill on scratch/isolated services.
- Verify no ordinary external effect occurs in restore mode.
- Measure actual RPO/RTO and update the operator runbook.
- Enable the new backup timer only after both repositories' pinned commits and
  live artifact hashes match the reviewed generation.

## Acceptance criteria

- A snapshot cannot omit an event or effect between the fenced databases.
- Restic contains only catalog-authorized complete generations, never live DB
  sidecars, provider credentials, or staging/quarantine data.
- Interrupted snapshots, uploads, pruning, and restores resume or fail closed
  without losing their original owner/token/state snapshot.
- A restore from a real restic snapshot passes manifest, membership, digest,
  SQLite integrity, provider-state, and runtime-release validation.
- Restore mode performs zero ordinary external mutations.
- Unknown or ambiguous restored effects park for review rather than replay.
- Old Pebble/Monologue namespaces remain disabled until new audited cutoffs are
  established.
- Normal operation resumes only after a mandatory fresh coherent generation,
  fresh-process health, hold release, prior timer/service restoration, and a
  durable terminal restore audit.

## Decisions required before promotion

- RPO, RTO, retention, and acceptable manual-review volume.
- Whether provider continuity state belongs in every generation or only named
  checkpoints.
- Which Slack evidence is sufficiently authoritative for each effect family.
- Whether the first release should cover restore or snapshot reliability only.

## Historical provenance

This proposal was extracted from the superseded 2026-08-19 platform-hardening
exploration, now stored under `docs/archive/`. That archive is evidence of prior
reasoning, not required reading and not implementation authority.
