---
failure: Agent sessions received a command path that did not exist in the installed Concierge release.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Agent sessions could not run their supplied Concierge command

## What was seen

Five agent reports in Inbox topics e793eb76, 6791724b, d8f389a5, cab280b8 and 6e139d93
observed a supplied command under a release's `control/bot/scripts` that exited 127 because
that file was absent. The same release had `control/systemd/router-actions.sh`, and the
installed `~/.local/bin/router-actions.sh` worked. The third report corrected the second:
release cleanup was not involved; the release was still present when the missing path was
checked. These are five retained reports of one defect, not five commands to replay.

## Cause

The runner's machine environment built the command path by appending `scripts/router-actions.sh`
to its release-bound bot helper directory. The release manifest packages the wrapper under
`control/systemd` and the deployment installs it at `~/.local/bin`. A local turn also accepted
an inherited command path, so a stale value could override the installed path.

## Fix

The owner and runner now derive the command path from the machine's home directory and set it
explicitly for provider turns. The owner strips its own command path before sending work to a
runner; the runner supplies its local path. The wrapper's existing routing to the current
installed session parser remains in charge of command semantics across releases.

## Acceptance scenario

- **Seed:** Start an agent session while the runner's bot helpers live under release N; prepare
  release N+1 with the wrapper still installed at the machine's stable location.
- **Action:** From the agent's shell, invoke the supplied command path for a read-only session
  command before and after the release change.
- **Expected:** Both invocations reach Concierge; the path never names either release's
  `control/bot/scripts/router-actions.sh`.
- **Replayable offline:** yes (runner environment construction and a scratch installed wrapper).
