---
failure: Recovery inspection rejects known earlier native conversation history as an unclassified new effect.
date: 2026-11-14
fix_commits: []
cause_status: confirmed
---

# Native history decoding and continuation proof

## What was seen

Source-only correction for PR866. No installed or target eligibility is established.

The d91dfed3 reader refused a native-known communication metadata record before
the selected interval. Earlier quota and checkpoint fixes had retained the same
architectural error: wire recognition, earlier history reconstruction and a proof
that new work had no effect shared one branch list. The parent's retained static
adapter stopped at record149; its mapping and path are diagnostic assertions,
never recovery authority. The full Pro consultation (request55a3a5b1) confirmed
the mismatch against upstream c1382380de69521303b416720a52f42d51af6248
(rust-v0.162.0).

## Cause

Source causes include incomplete rollout/response/event vocabulary, treating an
earlier typed compaction completion as requiring a selected interval, retaining
world/context baselines across compaction, payload-only replacement equivalence,
and conflating absent replacement history with an empty replacement list.
The pinned migration consumer pairs communication metadata only with the next
physical AgentMessage. Reconstruction resets world state at compaction; resume
metadata has authoritative optional values. Neither boolean communication flags
nor missing token usage prove effect neutrality.
The pair's instruction boundary is established by that physical marker, not by
equating its declared turn with the task active when delivery arrived. The pinned
rollback planner carries these identities separately; the fixture exercises that
separate attribution too.

## Fix

Parent's stable-EOF compatibility discriminator subsequently found 28 earlier
image tool-output refusals in the candidate. The synthetic official-shape
discriminator returned image false and text true. Source inspection confirmed a
schema interpreter defect: implicit closure on each properties-bearing subschema
rejected fields declared by sibling/union branches. This was a known native shape,
not missing target provenance. The source correction separates native validity
from complete typed-shape field coverage. Only native-valid union branches
contribute fields; explicit additionalProperties remains local to its schema.
Reference siblings and union siblings still constrain the value. Unknown typed
fields, invalid branch values and numeric identity failures still refuse. The
interpretation witness now binds the corrected interpreter version; the original
digest primitive and physical source identity are unchanged.

The correction keeps physical original bytes and the digest primitive. A pinned
decoder recognizes wire vocabulary separately from the reducer. Earlier known
effects are preserved with envelope references; interval effects still refuse.
Unsupported native semantics, unknown fields, malformed shapes and missing
provenance remain distinct failures. A failed proof still inventories the full
captured source; subsequent records cannot repair the failed proof implicitly.

Self-review also found that enum recognition alone did not validate every nested
response shape. The decoder binds the official pinned ResponseItem schema and its
fourteen transitive definitions, validates only the schema keywords actually in
that closed fragment, and refuses new keywords. Native classification/warehouse
passthrough fields omitted by Schemars are checked separately and remain part of
original provenance. Tool/provider data is opaque only where the native schema
declares unstructured JSON.

Native rollout parsing preserves decimal JSON values. JavaScript can collapse
distinct large numeric payloads before a payload-membership comparison. Source
comparison now retains numeric lexemes alongside parsed values and fingerprints a
typed source representation with the unchanged digest primitive. Replacement
envelopes, settings and reconstructed world state cannot borrow identity through
numeric rounding. Native integer fields also refuse fractional representations.
This representation is deliberately stricter than unproved numeric rewriting.

Acceptance uses disposable source files and the real reader/client composition,
with unrelated daemon maintenance/start callbacks stubbed. It covers historical
communications, envelope identity, reset/re-establishment and selected/suffix
effects. Parent retains the real-source discriminator and whole fresh review.
Legacy native positive-cut and first-protection writer-exclusion holds remain.
No rollout hash proves transient unpersisted effects; owner receipts and the
execution fence remain independently necessary. [decision: preserve-pushed-history]

## Acceptance scenario

- **Seed:** Disposable original JSONL with acknowledged prior effects, a physically paired communication, native checkpoint sidecars and exact selected/later attempt identities.
- **Action:** Read the complete source with the pinned decoder and reconstruct the baseline before applying interval policy.
- **Expected:** Earlier known effects retain their envelopes and source references; a valid later independent compaction resets/re-establishes baselines. New selected/suffix effects, stripped metadata, unknown fields and missing provenance refuse. A refusal inventories later records without restoring proof.
- **Replayable offline:** yes; `bun run scripts/codex-original-history-coverage-fixture.ts` and the composed continuation contract gate from `bot/`.
