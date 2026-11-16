---
failure: The Codex generation-loss fixture failed on Bun release runners because it required /usr/bin/node.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Codex generation-loss release checks require a runtime the runner does not have

## What was seen

Both GitHub Release checks 43492281241 and 43492271427 failed in
`codex-generation-loss-fixture.ts` with `ENOENT: posix_spawn '/usr/bin/node'` under
Bun 1.4.2. Earlier checks in those jobs had passed; the failure was in starting the
fixture bridge process, before its generation-loss assertions.

## Cause

The disposable fixture explicitly passed `/usr/bin/node` to the provider client.
The release runner provides Bun and does not guarantee a Node installation at that
path. This dependency belonged only to the fixture; production Codex runtime
configuration was not involved.

## Fix

The fixture now passes `process.execPath`, so the bridge runs under the runtime that
started the fixture. Production client defaults and runtime selection are unchanged.

## Acceptance scenario

- **Seed:** Run the generation-loss fixture with Bun and a `PATH` containing only Bun.
- **Action:** Connect to the disposable bridge, lose its captured generation, reconnect,
  then replay the old generation loss.
- **Expected:** The child disconnect is observed, reconnect creates a new generation,
  and the stale request leaves its successor alive; fixture cleanup completes.
- **Replayable offline:** yes.
