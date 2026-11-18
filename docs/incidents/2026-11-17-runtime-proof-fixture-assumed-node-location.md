---
failure: The runtime proof release check mistook a missing Node executable for its expected missing-socket failure.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# Runtime proof check assumed Node's installed location

## What was seen

Required CI failed the ordinary-client positive control: tune/move/start counters were `[1,1,0]`
instead of `[1,1,1]`. Local and CI Bun versions were both 1.4.2. The workflow did not guarantee
Node at `/usr/bin/node`; its normal executable could be elsewhere on PATH.

## Cause

The fixture hardcoded Node's location and accepted any `ENOENT` error. Actual missing-executable
failure matched that broad assertion but correctly did not trigger the client's missing-socket
autostart branch. A controlled unavailable fixed path with real Node on PATH reproduces the exact
CI counters against the unchanged original fixture. The specific CI filesystem was not directly
inspected, so its missing fixed executable remains the likely explanation of that CI occurrence.

## Fix

Resolve Node through the fixture's existing configured-executable/PATH convention and supply it
to both private and shared client checks. Require the exact emitted socket-connect error message.
Keep the ordinary autostart positive control and protected zero-effect assertions unchanged.
Print only the selected executable, static-path presence and Bun version for future CI evidence.
No production source, lifecycle default, timeout or retry changed.

## Acceptance scenario

- **Seed:** actual client/fixture with a valid Node on startup PATH and a controlled unavailable
  fixed executable; daemon lifecycle boundaries are counters, never real runtime effects.
- **Action:** run the original and corrected full proof fixture, including retained owner proof
  connection and old-receiver controls.
- **Expected:** original fails with `[1,1,0]`; corrected uses PATH Node, performs the expected
  ordinary autostart control and passes all five checks. Missing executable errors cannot satisfy
  the strict socket-error assertion. Production runtime source is byte-identical.
- **Replayable offline:** yes; run `bun run scripts/runtime-terminal-proof-fixture.ts` from `bot/`
  with Node available through PATH or `CONCIERGE_NODE_BIN`. Exact unavailable-path reproduction
  and original/corrected outputs are retained in the task's ignored review evidence.
