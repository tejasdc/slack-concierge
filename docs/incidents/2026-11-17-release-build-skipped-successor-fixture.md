---
failure: The required release build passed without running the default Codex custody successor fixture, because a missing `&&` made it ignored arguments of the edit-gate fixture.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# The release build skipped the default custody successor fixture

## What was seen

A reviewing agent noticed that `bot/package.json`'s build ran
`bun run scripts/implementation-edit-gate-fixture.ts bun run scripts/codex-custody-successor-fixture.ts`
as one step. The edit-gate fixture ignores its arguments, so only the `--relay`
variant of the custody successor fixture ran; the default scenario was never exercised
by the Release check.

## Cause

A missing `&&` separator in the one-line build chain. Nothing checked that each step
of the chain launches exactly one program.

## Fix

Restore the separator, and run `bot/scripts/build-chain-check.ts` as the first build
step: it splits the build on `&&`, `||` and `;` and refuses any step that does not start
exactly one program (`bun run|build|test`, `python3`, `node`, `bash`, `sh`), with a
built-in self-test on a joined sample. The default successor fixture passed once it ran
(about 10 seconds).

## Acceptance scenario

- **Seed:** a build script whose chain contains `bun run a.ts bun run b.ts` as one step.
- **Action:** run `bun run scripts/build-chain-check.ts` (the build's first step).
- **Expected:** it exits non-zero naming the joined step; with the separator restored it passes and the build output shows `custody successor owner fixture passed` twice (default and relay).
- **Replayable offline:** yes
