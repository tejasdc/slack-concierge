---
failure: A Concierge update failed while trying to add protection inside an already protected release check.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# Candidate preparation rejected an inherited disk-image mask

## What was seen

Deployment run `96b0e0c8-6401-4cc4-8da0-371918de6e23` failed at candidate activation
for `40dc46390b270ef0de885db82b0f98ab789fa95c`. The database-safety fixture failed
at its ledger-access refusal child with `bwrap: setting up uid map: Permission denied`.
The retained command output and deployment journal record restoration to
`c3be3cebe56ca744b2518fdc136e9c3c74f000e0`; the sealed control manifest also names
that commit. Incident: `15e3ccf9-b90d-4ae9-9373-0c8e463aeb98`.

## Cause

The installed builder's retained bundle masks live database directories and binds
`/dev/null` over loop backing images before dropping all capabilities. The candidate's
`privateDatabaseCommand` recognizes the inherited database boundary but now calls
`agentLedgerImageCommand`, which accepts only the newer inaccessible 0:0 device as
an existing image mask. The legacy null device therefore causes a fresh, nested
bubblewrap launch. Its uid-map setup fails in the already restricted check process,
before the Python child runs. This causal path is present in the retained source and
installed bundle; commit provenance mappings were not used as causal evidence.

Evidence: the incident's `failed-command/stdout.log`, the presentation-check directory
for the exact deployment run under `candidate-check-failures`, the deployment journal,
and the sealed control's `control/release-manager.js` and `manifest.json`.

## Fix

Release commands reuse the legacy null-image mask only alongside the inherited
database boundary, a non-initial user namespace, and a character-device image matching
`/dev/null`'s device identity. A regular file or unrelated device cannot select this
compatibility path. This preserves the preceding builder's protection from production
bytes without attempting an unavailable namespace upgrade. Fresh release isolation
and the stricter denied-open boundary for agent launches remain unchanged.

No tests, reviews, candidate retries, production database inspection, deployment,
service restarts or managed-session actions were performed. Integration and runtime
acceptance remain with the external supervisor and detached deployment controller.

## Acceptance scenario

- **Seed:** The preceding sealed builder masks database directories and replaces the
  ledger image with `/dev/null` in a user namespace, then drops capabilities.
- **Action:** That builder prepares a candidate containing this correction.
- **Expected:** The refusal child runs under the inherited boundary without another
  bubblewrap launch and reports the canonical ledger inaccessible. Regular images
  cannot select legacy reuse; new agent launches still require the inaccessible
  device and their separate installed acceptance. Candidate activation and service
  health require the normal controller's evidence.
- **Replayable offline:** yes, with owned scratch state and a scratch image standing
  in for the protected host paths in disposable Linux namespaces.
