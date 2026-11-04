---
failure: A Concierge restart during a Claude Code reinstall marked 25 running agents as parked, so their sessions went idle while the agents kept working with no one listening and their replies were refused.
date: 2026-11-04
fix_commits: [6c9b01f2]
cause_status: confirmed
---

# Running agents were cut off after a restart

## What was seen

At 17:06 UTC Concierge restarted (an update) and took back its running Claude runs from their
execution hosts (`execution_adopted`). Seconds later 25 turns logged `provider_turn_parked` with
"cannot find the Claude CLI (claude) on this coordinator's PATH", class `parked_ambiguous`.
Their sessions went idle and thread requests got stalled notices, but every agent process kept
running. Their router-actions calls were refused ("Source must identify this admitted input and
its exact live run"), so they could not reply, report or declare an outcome. Two runs (turns
20800 and 20787) were fresh launches at that moment and never started.

## Cause

Claude Code was being reinstalled on the server at the same time: `/usr/bin/claude` was replaced
at 17:07 UTC (what ran the reinstall was not found in the journal). Adoption built its hosted
transport through `claudeExecutable()`, which needs `claude` on PATH, although only a launch uses
the executable. The throw became a setup failure, and `settleSetupFailure` parks a run whose
provider admission was intended. Startup adoption only considers turns in `running`, so nothing
ever takes a parked run with a live host back.

## Fix

Commit 6c9b01f2 (PR 418): adoption no longer resolves the Claude CLI or re-runs the Google CLI
check; only a launch does.

Not yet done (needs its own change): taking back the runs already parked. At the time of writing,
18 parked turns had a live host and no later turn in their session (20606, 20615, 20620, 20704,
20706, 20736, 20737, 20739, 20744, 20753, 20759, 20760, 20761, 20764, 20769, 20770, 20772, 20777).
Simply setting them back to `running` before `claimAdoptableExecutions` is not safe: the failed
attempt already recorded `terminal:<turn>:<attempt>` with run state `uncertain`, and the adopted
run's own terminal event would conflict with it (`recordSessionEvent` throws "Event identity
conflict"). Five sessions (turns 20629, 20690, 20720, 20779, 20784) already started later turns
while the earlier agent still runs in the same Claude conversation; those old agents are a
second writer to that conversation and should be stopped or explicitly settled. The launch case
(a fresh run finding no CLI mid-reinstall) still fails its turn instead of retrying.

## Acceptance scenario

- **Seed:** a running Claude turn with a live execution host; `claude` absent from PATH.
- **Action:** restart Concierge so it adopts the run.
- **Expected:** the run is adopted live (`execution_host_attached`, provider running) and is not
  parked; the agent's router-actions calls keep working.
- **Replayable offline:** no (needs an execution host under systemd and a coordinator restart).
