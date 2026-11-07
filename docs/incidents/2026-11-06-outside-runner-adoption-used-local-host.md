---
failure: An outside agent finished on the runner but Concierge kept its turn running after an update.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Outside Codex runner adoption used the local host

## What was seen

At 08:51 UTC, Concierge admitted the exact outside Codex request in session 8986 on
the AX41 runner. The provider acknowledged it, reported its answer, and the runner
host recorded exit code 0 at 09:02:03 UTC. The host journal ended at frame 171 with
the exit frame and no journal error. The owner nevertheless kept turn 24110 running,
leaving later input queued. Five owner restarts adopted execution
`b70b6743185b2f19`, but none logged a host attachment or settled the turn.

## Cause

The launch path records a runner supervisor for an outside Codex turn. The outside
adoption path omitted that supervisor when it built the transport, so it tried the
server's local host socket instead of the runner's retained host. Local host custody
could not find a host there; the owner held the run rather than replaying the
acknowledged provider input. This preserved safety but blocked the session.

## Fix

The correction selects runner host access from the recorded supervisor on adoption,
the same invariant used for Claude runner hosts. The original execution and journal
remain the settlement source; no new provider turn or ledger edit is permitted.

## Acceptance scenario

- **Seed:** An outside Codex turn has an acknowledged provider input, a runner
  execution row and a finished runner host journal, while the owner restarts
  before settling the turn.
- **Action:** The new owner adopts that exact execution.
- **Expected:** The owner reads the runner's exit frame, settles the original
  turn from the provider result and permits its queued successor to proceed;
  no new provider turn starts.
- **Replayable offline:** yes (a stand-in owner and runner host with retained
  journal can exercise the same adoption path).

Verification boundary: before installation, direct read-only host status showed
`exit.code=0`, `providerPid=null`, `lastSeq=171`, and the owner ledger showed a live
execution and running turn. After installation, check the same turn becomes terminal,
the exact provider result is retained, and the queued successor can proceed. Do not
claim recovery from the build or merge alone.
