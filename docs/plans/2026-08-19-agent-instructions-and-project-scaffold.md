# Agent instructions and canonical project scaffold

Status: approved for implementation on 2026-08-19.

This plan completes the accepted agent-instruction refactor. It changes repository behavior only where necessary to make the code-root instruction authority real: Canvas lookup, project creation/adoption, and an explicit migration command. After implementation and independent review, the migration is rolled through every project named by the live Concierge registry without modifying registry rows.

## Invariants

1. A managed code project has one real `AGENTS.md` at its code root. `CLAUDE.md` is a same-directory symlink to `AGENTS.md`.
2. Vault-only channels continue to use `<vault_path>/AGENTS.md`; once a channel has `code_path`, Canvas and agents use `<code_path>/AGENTS.md`.
3. Project notes remain real under `<vault_path>/notes`, and `<code_path>/notes` is a symlink to that directory.
4. Creation, adoption, and migration call one scaffold implementation. Shell entry points contain no independent convergence policy.
5. The baseline instruction file is concise and project-specific: a project heading, its actual working directory, and a project map that routes durable documentation to `docs/README.md` and captured notes to `notes/`. The scaffold creates that documentation index but no speculative architecture, runbook, plan, incident, or agent-specific directories.
6. Reconciliation inspects all instruction candidates before writing. Known generated placeholders may be replaced; customized content is copied byte-for-byte into the canonical file. Divergent customized files are reported as ambiguous and left untouched.
7. Existing real notes are preserved through a deterministic backup before the canonical symlink is installed. Existing vault notes are never overwritten on collision.
8. Migration reads only managed rows from the Concierge `channels` registry. It does not discover projects with an unrestricted workspace scan, does not update the registry, defaults to dry-run, skips unsafe/out-of-root paths, and reports migrated, unchanged, skipped, and ambiguous projects.
9. Any blocker makes ordinary apply zero-write. Intentionally retained stale or unsafe registry rows require a versioned manifest whose fingerprints exactly equal the current blocker set; relevant filesystem drift invalidates the review.
10. Applying migration, propagating Git changes, and switching Canvas authority are one coordinated cutover. It persists pre-mutation state plus exact per-repository propagation intent, reuses the existing provider/capture deployment gates, stops the old bot before migration, resumes and proves every verified scaffold push across interruption, and reopens admission only after strict Slack-visible Canvas refresh and normal deployment health.
11. Re-running creation, adoption, or an applied migration produces the same scaffold without replacing valid files. The cutover runs the migration twice and requires zero projects to migrate on the second pass.
12. Documentation is organized by purpose and judged by relevance, not arbitrary file-size or line-count limits. There is no integrations category.

## Documentation layout

- `docs/README.md` — index and authority guide.
- `docs/architecture/` — distinct current-behavior documents for turn/provider lifecycle, Slack input, and capture ingress.
- `docs/runbooks/DEPLOYMENT.md` — deployment, service, transcription-runtime, and restore procedures.
- `docs/runbooks/SLACK-APP-ADMINISTRATION.md` — manifest and OAuth administration.
- `docs/runbooks/CHANNEL-ADOPTION.md` — project scaffold, adoption, migration, and custom-vault channel procedures.
- `docs/plans/` — reviewed design and implementation records, including this plan.
- `docs/incidents/` — dated failure evidence and lessons.

The existing top-level `DESIGN.md`, `IMPLEMENTATION.md`, `REQUIREMENTS.md`, `REQUIREMENTS-EXTRACTED.md`, and `STATUS.md` remain untouched historical records. They are indexed as history, not current truth.

## Implementation sequence

1. Add the documentation index, split current behavior into distinct documents under `docs/architecture/`, put only deployment, Slack-app administration, and channel-adoption procedures under `docs/runbooks/`, and update all repository links.
2. Add a side-effect-bounded scaffold module that plans and applies the canonical structure, classifies instruction provenance, preserves customized content, and reports ambiguity.
3. Route Slack channel creation and promotion through that module. Replace adoption's duplicated shell implementation with a TypeScript entry point using the same module and keep the shell filename as a compatibility wrapper.
4. Replace the unrestricted legacy instruction migration with a registry-scoped, dry-run-by-default migration entry point using the same module. Classify the complete inventory before writes and bind reviewed exceptions to exact state fingerprints.
5. Add a Git audit and propagation boundary for only the repositories that will change. Require canonical repo roots, synchronized origin-tracking branches, and either a clean tree or exact verified untracked scaffold shapes; persist their prepared identities/actions/HEADs before writes; bind every individual reconcile to that decision immediately before mutation; resume incomplete exact commits and pushes; and finish by auditing the full intent.
6. Resolve Canvas instruction paths from `code_path` when present and from `vault_path` only for vault-only channels. Add a durable strict-refresh startup mode for cutover.
7. Add a coordinated cutover wrapper that persists `blocked` state before mutation, reuses the existing deployment and capture gates, stops the old bot before migration, performs recoverable migration plus Git propagation, proves second-run idempotency, advances to strict Canvas state, and hands off to the normal deploy health gate.
8. Add focused tests for canonical structure, the documentation index, exact custom-content preservation, conflict refusal, path/symlink rejection, exception drift, Git dirt and identity checks, interrupted and mid-fleet propagation recovery, prepared/apply drift refusal, Canvas source selection and null-channel exclusion, registry scoping, migration reporting, sync restoration, stateful cutover failure, ordering, and second-run idempotency.
9. Run targeted tests during implementation, link/symlink/diff/shell checks, and an independent fresh-context review of the actual implementation and migration safety. Fix every NO-SHIP finding and repeat review.
10. After a SHIP verdict, run the full Bun suite once, commit and push the reviewed branch, and integrate it into `main`.
11. From integrated `main`, run the live registry migration in dry-run mode, review or resolve every skipped and ambiguous project, create an exact exception manifest only for intentionally retained blockers, and invoke the one-time cutover wrapper.

## Rollout boundary

Implementation and tests run only in the isolated Slack Concierge worktree. The live migration begins only after independent review issues SHIP and the reviewed branch is integrated into `main`. It then:

1. reads `/root/.local/state/concierge/state.db` in read-only mode and runs a dry report;
2. reviews every ambiguous or skipped project before any apply step and requires an exact current-state fingerprint manifest for any intentionally retained blocker;
3. preserves customized instructions and deterministic pre-canonical backups;
4. audits and prepares only repositories whose dry outcome is `migrated`, refusing genuine dirt, unpushed commits, noncanonical same-named paths, or unsafe repository identity;
5. applies only through `bot/scripts/project-scaffold-cutover.sh`, under the existing provider and capture deployment gates;
6. commits and pushes only exact scaffold-owned paths, durably checkpoints every repository, then runs the same migration again and requires zero migrated projects plus a clean/origin-synchronized audit of the entire persisted intent;
7. leaves all live registry rows unchanged;
8. requires all Slack-visible Canvases to refresh from the new authority before bot startup announces healthy service and admission gates release; registry-only null-channel adoption rows are intentionally excluded.

## Validation targets

- Structure: real code-root `AGENTS.md`, sibling `CLAUDE.md` symlink, useful `docs/README.md`, vault notes, code notes symlink, and no generated empty architecture/runbook or `.codex`/`.claude` directories.
- Preservation: custom instructions survive byte-for-byte; matching duplicates converge; divergent custom files remain untouched and are reported.
- Canvas: managed code projects read the code-root file; vault-only channels read the vault file; missing files retain the existing empty fallback.
- Migration: only registry rows are considered; relative, missing, out-of-root, overlapping, and canonical-duplicate paths fail closed; dry-run is non-mutating; apply is globally zero-write on unreviewed blockers; exact exceptions invalidate on drift; each project revalidates its exact prepared decision at the mutation boundary; reports contain every category.
- Git: the initial dry audit targets only `migrated` repositories; verified untracked canonical scaffold shapes may proceed, while tracked dirt, unexpected paths, same-named noncanonical files or links, detached/ahead/divergent branches, and missing origin/upstream block. Apply persists exact prepared identity/actions/HEADs, recovery includes targets now classed `unchanged`, crash and mid-fleet tests resume remaining pushes, and the final gate proves the entire intent clean and origin-synchronized.
- Cutover: durable `blocked` state precedes mutation and is checked before abandoned-drain cleanup; old authority stops before migration; existing deployment gates stay held through strict Slack-visible Canvas refresh; null-channel rows are excluded; second migration reports zero migrated projects; sync always restarts when initially active; and failures preserve phase-specific recovery state.
