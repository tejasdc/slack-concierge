# Router session-search implementation record

Date: 2026-09-09. This records the complete local delivery of the
[approved design](../brainstorms/2026-09-03-router-session-search-and-routing.md).
The [architecture](../architecture/ROUTER-SEARCH.md) and
[helper runbook](../runbooks/ROUTER-ACTIONS.md) remain current runtime authority.
Rollout is not treated as implementation evidence: the ordinary handoff is a
non-force push to `origin/main`, after which the detached deployment workflow
owns activation and health proof.

The SQLite ledger owns a transactional, rebuildable FTS5 routing projection.
The read-only helper requires a managed channel and triggering timestamp,
honors an excluded root, returns exact Slack identities and completeness, and
uses OR/BM25 retrieval. Concierge supplies the resume-or-clarify contract beside
each real input, including steering. Clearly new work retains ordinary posting.
There are no dependency, credential, service, polling, or deployment additions.

## Verification

Commands below ran from `bot/` unless stated otherwise. All listed completed
checks exited 0. Test logs are preserved beneath the final sandbox evidence's
`validation/` directory.

| Check | Exact command | Result |
| --- | --- | --- |
| Focused runtime, projection, helper and installation | `bun test tests/router-search.test.ts tests/sandbox/router-search.test.ts tests/sandbox/runner.test.ts tests/attachments.test.ts tests/routing.test.ts tests/state-fork-lock.test.ts tests/state-schema-migration.test.ts tests/agent-projection-state.test.ts tests/router-post.test.ts tests/deploy.test.ts` | 324 pass, 0 fail, 1,353 assertions |
| Turn, steering, status and live adapter integration | `bun test tests/turn-execution.test.ts tests/thread-status.test.ts tests/steering.test.ts tests/sandbox/live-typed-turn.test.ts` | 52 pass, 0 fail, 428 assertions |
| Screenshot harness repair | `bun test tests/sandbox/browser-driver.test.ts tests/sandbox/router-search.test.ts tests/sandbox/runner.test.ts` | 18 pass, 0 fail, 105 assertions |
| Final review corrections and sandbox wiring | `bun test tests/router-search.test.ts tests/steering.test.ts tests/sandbox/router-search.test.ts tests/sandbox/browser-driver.test.ts tests/sandbox/runner.test.ts` | 77 pass, 0 fail, 312 assertions |
| Runtime and credential-free helper build | `bun build src/index.ts scripts/router-threads.ts --target=bun --outdir /tmp/concierge-router-search-build` | 460 modules bundled |
| Shell syntax, repository root | `bash -n systemd/router-actions.sh` | Passed |
| Whitespace, repository root | `git diff --check origin/main` | Passed |
| Full integration gate, once after implementation and sandbox acceptance | `bun test` | 1,127 pass, 0 fail, 4,848 assertions across 96 files; 95.21 seconds |

This Bun package defines no typecheck or lint script, TypeScript configuration,
or lint configuration. The build and shell syntax checks above are the available
static checks; bundling is not represented as TypeScript typechecking.
The final documentation audit resolved 81 local links and verified the
`CLAUDE.md -> AGENTS.md` symlink. The changed-file credential scan found no
credential material. No implementation blockers remain.

One fresh-context independent review inspected the whole diff against
`origin/main`, new files, focused results, and live behavior evidence. Its two
reproduced findings were corrected together: real acknowledged steering and
delivered TL;DRs on synthetic turns remain eligible while synthetic initial
prompts stay excluded; ledger rebuild now repairs missing FTS postings before
document deletion. Regressions failed before these fixes and passed afterward.
The parent self-reviewed the complete resulting diff, eligibility and mutation
owners, instructions, documentation links, non-goals, and sandbox evidence.

## Real Slack acceptance

The official four-lane controller claimed lane 1 for run
`20260909T210541Z-3221868-6611` from this worktree. The source identity was
`5e756c08e423f15cb88c3cff067b97b33e9becf6+7b533492e2234c83`, with complete dirty
digest `7b533492e2234c83be653ed2dbf7a596d107f12bd6085b6514f16251e21af5e0`.
Product and test file hashes in `validation/product-source.json` bind the final
implementation to this tested source; only this validation record and related
documentation status/index links were added afterward.

Exact command:

```bash
cd bot
bun run tests/sandbox/runner.ts execute router-search --lane lane-1 --run-id 20260909T210541Z-3221868-6611 --apply
```

Exit 0. The cold DM router selected historical sandbox root
`1788987961.645369` in `C0BSKT0MBRD`, despite a newer unrelated root, and caused
exactly one reply there with the same provider-session ownership. Empty search,
an unavailable run-local helper database, and two plausible roots each caused
one DM clarification and zero destination work. API/ledger checks confirmed
delivery, five authenticated Chromium captures showed the actual responses at
1280×577, and the case proved zero unsettled work. Production Slack received no
validation writes.

Evidence root:
`/var/lib/slack-concierge-sandbox/lanes/lane-1/runs/20260909T210541Z-3221868-6611/evidence/`.
`router-search.json` is the complete result; `router-search-{resume,empty,failed,ambiguous}.json`
retain individual decisions, and `browser/` holds PNG, accessibility, and geometry
evidence. `validation/release.json` proves the exact run was released with no
candidate or capture sibling remaining, after closing its exact browser session.

Earlier run evidence is also preserved. Run `20260909T205109Z-3166781-21143`
passed routing assertions but exposed a screenshot filename collision; distinct
capture names fixed it. Run `20260909T205623Z-3180732-13511` passed before the
review corrections. The final run above supersedes both as implementation proof.

## Plan deviations

PLAN DEVIATION: prove production root `1786558965.762069` through sandbox Slack ->
assert that exact root in the deterministic incident fixture and prove the
equivalent sandbox-created historical root in real Slack -> Slack assigns root
timestamps; the production identity cannot exist in an isolated sandbox.

PLAN DEVIATION: expose allocated FTS index bytes -> expose database page bytes
and explicitly labeled compressed `fts_payload_bytes` -> this Bun SQLite build
does not provide `dbstat`, so payload bytes must not be described as allocated
index size.

The existing legacy per-thread SQL predicate could match both a session root
and an individual reply. Its replacement is one shared, mode-aware visible-root
expression, preserving explicit and claim identities and single-persistent
visible roots. Router guidance is injected by Concierge's existing input owner
so active router sessions receive it without a second repository edit.
