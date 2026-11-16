---
failure: Custody-successor recovery refused the configured co-located Codex runner relay, and large provider transcripts prevented worktree inventory.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Custody recovery over the configured runner relay

## What was seen

The first installed activation refused before changing custody because the protected factory
required a direct native endpoint while production uses the configured runner relay. Separate
local-only predicates and process observations had the same assumption. Removing only the
factory refusal would have allowed ordinary runner-side daemon management and left actual
connection association and effective helper preparation unproved.

## Cause

Direct transport was being used as a proxy for shared observation namespaces. The
ordinary relay also manages its daemon and rewrites the construction environment,
so simply accepting its runner name would not establish the missing invariant.

## Fix

The repair extends the existing relay with a distinct protected open, exact pair/native
incarnation evidence, shared-namespace validation and bound effective runner preparation.
Each captured sender retains its own evidence. A new listener cannot attest an old pair,
and reconnect never grants mutation authority. Exact Stop keeps its control exception.

A second confirmed refusal came from a retained 119,714,180-byte transcript exceeding the
runner worktree scanner’s 64 MiB eager-read limit. The existing runner query now streams
registered Git worktree path references. It preserves phase and original nonsecret errors
instead of translating every failure into runner unavailability. A smaller transcript
failed historically too; its underlying error was not retained and its cause remains unknown.

Replay the disposable inventory fixture with and without --baseline, the protected relay
stock/--sealed fixture, the negative relay fixture, and the custody successor fixture
with --relay. Each fixture/report names its native-response or host-effect substitutions.
The stock fixture isolates HOME, CODEX_HOME and its native socket. No fixture result
establishes live target coverage, native effect disposition or repaired productive work.

## Acceptance scenario

- **Seed:** Isolated HOME/CODEX_HOME, an already-running stock native socket, co-located
  fixture runner/gateway, retained predecessor input and a large transcript/worktree fixture.
- **Action:** Run `bun run bot/scripts/codex-protected-relay-fixture.ts --sealed`,
  `bun run bot/scripts/codex-protected-relay-negative-fixture.ts`, and from `bot/`
  `bun run scripts/codex-custody-successor-fixture.ts --relay` and
  `bun run scripts/runner-worktree-inventory-fixture.ts`.
- **Expected:** Exact physical association and one protected selected attempt work;
  old listener, stale pair, unsupported namespace, missing daemon, failed hook pin,
  unresolved effects and failed inventory cannot authorize construction/admission.
  Large transcripts stream through the existing runner query. Exact Stop stays usable.
- **Replayable offline:** yes; stock checks exercise transport/read only, while the
  owner sequence substitutes native turn responses and process observations.

Current contracts: docs/architecture/RUNNERS.md and the custody-successor section of
docs/runbooks/ROUTER-ACTIONS.md. Parent review and release retain real activation responsibility.
