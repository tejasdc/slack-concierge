# Channel creation, adoption, and scaffold migration

Concierge has one canonical managed-project scaffold. New channel creation, existing-project adoption, and registry-scoped migration all call `bot/src/project-scaffold.ts`; their entry points must not grow independent filesystem policy.

## Canonical managed-project shape

For project slug `<slug>` under `/root/workspace`:

```text
/root/workspace/<slug>/
  AGENTS.md                 real, git-tracked project instructions
  CLAUDE.md -> AGENTS.md    same-directory compatibility symlink
  docs/README.md            useful documentation index
  notes/ -> ../vault/projects/<slug>/notes

/root/workspace/vault/projects/<slug>/notes/
  inbox.md                  synced ephemeral capture
```

The concise generated `AGENTS.md` names the working directory and routes readers to durable docs and synced notes. The scaffold does not create speculative empty `.codex`, `.claude`, architecture, runbook, or plan directories. A newly created code root is initialized as a Git repository unless explicitly disabled for a controlled test.

Customized instruction, documentation, and note content is preserved. If several customized instruction candidates disagree, reconciliation reports `ambiguous` and changes nothing. Old vault-owned instructions are archived as `<vault_path>/AGENTS.md.migrated-to-code-root`. If the code root contains a real `notes` directory, missing entries are copied to canonical vault notes and the original is preserved as `<vault_path>/notes.pre-concierge-scaffold`; collisions remain in that backup.

Path inspection fails closed. Code and vault roots must be real directories strictly below the canonical workspace root and may not overlap. Instruction symlinks are accepted only for the legacy code `AGENTS.md -> <vault_path>/AGENTS.md` shape or canonical sibling `CLAUDE.md -> AGENTS.md`; their targets must be inspectable regular files. The only accepted code-side notes symlink is the exact canonical link to `<vault_path>/notes`. Dangling, cyclic, external, duplicate-canonical, or otherwise noncanonical paths are reported without writes.

## Create a channel

Use Concierge's `/create-channel` workflow. It creates Slack surfaces and applies the shared scaffold. The ordinary paths are:

```text
code_path=/root/workspace/<slug>
vault_path=/root/workspace/vault/projects/<slug>
```

## Adopt an existing code project

Inspect without mutation first:

```bash
bot/scripts/adopt-project.sh <slug> --dry-run
```

Review every action and warning, then apply:

```bash
bot/scripts/adopt-project.sh <slug> --pause-sync
```

Adoption requires the code root to exist. It reconciles the shared scaffold first, then idempotently upserts the project registry row. `--pause-sync` stops and restores `obsidian-sync` only around the applying run. Use `--workspace-root` and `--state-db` only for an intentional alternate environment.

## Migrate all managed projects

Inventory comes only from registry rows with a non-null `code_path`; the migration never scans arbitrary workspace directories and never changes the registry. The default is a dry run:

```bash
/root/.bun/bin/bun run bot/scripts/migrate-project-scaffolds.ts
```

Run this only from the reviewed branch after it is integrated into `main`. Review every project classified `migrated`, `unchanged`, `skipped`, or `ambiguous`. The initial dry report includes exact exception fingerprints for all current blockers and a read-only Git audit of only the projects that would migrate. Once a cutover has persisted propagation intent, recovery audits that complete intent even when its files now classify `unchanged`.

Resolve genuine customized-content or path ambiguity before cutover. A registry row that is intentionally stale, missing, or outside the workspace may be accepted only with an exact reviewed-exception manifest built from the current dry report:

```json
{
  "version": 1,
  "fingerprints": ["<64-character fingerprint from the current dry report>"]
}
```

The manifest must equal the complete current blocker set: missing or extra fingerprints, duplicates, malformed values, or relevant file/path-state drift refuse apply. Without the exact manifest, any blocker makes normal apply zero-write.

Do not invoke the migration CLI directly with `--apply`. It refuses apply unless the coordinated cutover explicitly authorizes it and Git propagation is enabled. Use the one-time cutover wrapper:

```bash
bot/scripts/project-scaffold-cutover.sh
bot/scripts/project-scaffold-cutover.sh --reviewed-exceptions /absolute/path/to/reviewed-exceptions.json
```

The wrapper reuses the existing deployment gate and capture hold. Immediately after gate acquisition it atomically creates `project-scaffold-cutover.json` in the Concierge state directory with phase `blocked`; bot startup refuses that phase before abandoned-drain recovery. It then drains providers, stops the old bot before instruction authority changes, revalidates the exact exception set, fetches and prepares every changing repository, and persists exact canonical paths, prepared HEAD/upstream, actions, expected Git state, and per-project propagation completion before filesystem writes.

Active `obsidian-sync` is paused and restored around apply. The applying preflight must remain bound to the prepared inventory; new candidates, action/state drift, path drift, or HEAD/origin drift refuse before writes. Each project's reconcile also rechecks its exact canonical roots, action list, and expected final Git fingerprint after synchronous inspection and immediately before its first mutation, closing drift between fleet validation and a later project's apply turn. Git propagation resumes every incomplete persisted target even when its scaffold is already `unchanged`, accepts only the prepared HEAD or its exact scaffold commit, checkpoints every successful push, and finishes with a clean/origin-synchronized audit of the entire intent. The second migration must report zero `migrated` while that fleet audit remains green.

Only then does state advance to `canvas_required`. Startup preserves the deployment drain, strictly refreshes every Slack-visible channel, and publishes `concierge_bot_online` for the normal health probe. Registry-only adopted rows with `slack_channel_id=NULL` are deliberately excluded because they have no Slack surface. After health and both gate releases, the wrapper proves the provider deployment gate is absent and removes cutover state. Registry rows are compared before and after and must remain unchanged.

Git preflight requires each changing code path to be its repository root on a symbolic branch with `origin/<branch>` as upstream. Read-only audit requires no cached ahead/behind difference; apply fetches origin, rejects unpushed commits, and rebases behind-only branches. Tracked dirt, unexpected untracked paths, noncanonical same-named files or links, detached heads, missing origin/upstream, or remaining divergence block before migration. Only pre-existing untracked scaffold paths whose exact shape is already canonical are allowed. The report records branch, upstream, before/after commit IDs, commit ID, push result, and sanitized failures.

If cutover fails after acquiring its gates, it deliberately leaves both gates closed and may leave the old bot stopped. Inspect the durable report directory and current phase:

```bash
CONCIERGE_STATE_DIR=/root/.local/state/concierge \
  /root/.bun/bin/bun run bot/scripts/project-scaffold-cutover-state.ts show
```

In `blocked` or `propagating`, bot startup refuses before abandoned-drain cleanup. Correct the reported condition, release only the exact logged gate tokens, and rerun the cutover wrapper; it resumes every incomplete propagation target from durable intent:

```bash
CONCIERGE_STATE_DIR=/root/.local/state/concierge \
  /root/.bun/bin/bun run bot/scripts/drain-status.ts release <logged-turn-gate-token>
CONCIERGE_CAPTURE_STATE_DIR=/var/lib/concierge-capture \
  /root/.bun/bin/bun run bot/scripts/capture-drain-status.ts release <logged-capture-gate-token>
```

In `canvas_required`, filesystem and Git gates already passed. After correcting the deploy/Canvas failure and releasing only the logged dead-owner tokens, run the normal deploy and then complete the state transition:

```bash
bot/scripts/deploy.sh
CONCIERGE_STATE_DIR=/root/.local/state/concierge \
  /root/.bun/bin/bun run bot/scripts/project-scaffold-cutover-state.ts complete
```

The complete transition refuses while either the provider deployment gate or capture delivery gate exists. Do not start or reopen admission merely to bypass a `blocked`/`propagating` failure.

The compatibility wrapper `bot/scripts/migrate-agents-md.sh` invokes the same migration. Do not add filesystem logic to the wrapper.

## Vault-only exceptions

A channel may intentionally have `code_path=NULL` and a custom `vault_path`; migration excludes it and Canvas reads its vault-local `AGENTS.md`. Current exception: `#blogs` uses `/root/workspace/vault/blogs`.

If a blog piece becomes a code project, create or adopt it normally. Keep its real instructions in the code root and its prose/capture notes in the matching vault folder. Do not recreate a vault-owned instruction file or cross-directory instruction symlink.

## Focused authority

- Shared policy: `bot/src/project-scaffold.ts`
- Registry inventory/upsert: `bot/src/project-registry.ts`
- Registry-scoped migration: `bot/src/project-migration.ts`
- Git audit and propagation evidence: `bot/src/project-git.ts`
- Channel creation: `bot/src/channel.ts`
- Adoption and migration CLIs: `bot/scripts/adopt-project.ts`, `bot/scripts/migrate-project-scaffolds.ts`
- Coordinated cutover: `bot/src/project-cutover-state.ts`, `bot/scripts/project-scaffold-cutover.sh`, the existing deployment gate in `bot/scripts/deploy.sh`, and startup Canvas refresh in `bot/src/index.ts`
- Tests: `bot/tests/project-scaffold.test.ts`, `bot/tests/project-adoption.test.ts`, `bot/tests/project-migration.test.ts`, `bot/tests/project-migration-command.test.ts`, `bot/tests/project-git.test.ts`, `bot/tests/project-cutover.test.ts`, and `bot/tests/project-cutover-state.test.ts`
