---
failure: A Concierge restart during a Claude Code reinstall marked 25 running agents as parked, so their sessions went idle while the agents kept working with no one listening and their replies were refused.
date: 2026-11-04
fix_commits: [6c9b01f2, c8efc5ff, fccc0db5]
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
at 17:07 UTC. The initiator was Codex session `concierge:8435` (`gpt-6-sol`, server,
`/root/workspace/slack-concierge`), handling an Inbox report that the installed Claude Code was
22 versions behind. Its retained transcript records the agent's `npm install -g
@anthropic-ai/claude-code@latest` command at 17:05:47 UTC and completion at 17:07:09 UTC
(`~/.codex/sessions/2026/11/04/rollout-2026-11-04T11-58-29-01a1a77f-6ad7-7961-8306-db06fd4b25dc.jsonl`,
entries 124 and 142–143). This command interval overlaps the 17:06 restart and the missing
command. Adoption built its hosted
transport through `claudeExecutable()`, which needs `claude` on PATH, although only a launch uses
the executable. The throw became a setup failure, and `settleSetupFailure` parks a run whose
provider admission was intended. Startup adoption only considers turns in `running`, so nothing
ever takes a parked run with a live host back.

## Fix

Commit 6c9b01f2 (PR 418): adoption no longer resolves the Claude CLI or re-runs the Google CLI
check; only a launch does.

The first repair did not take back the runs already parked. At the time of that repair,
18 parked turns had a live host and no later turn in their session (20606, 20615, 20620, 20704,
20706, 20736, 20737, 20739, 20744, 20753, 20759, 20760, 20761, 20764, 20769, 20770, 20772, 20777).
Simply setting them back to `running` before `claimAdoptableExecutions` is not safe: the failed
attempt already recorded `terminal:<turn>:<attempt>` with run state `uncertain`, and the adopted
run's own terminal event would conflict with it (`recordSessionEvent` throws "Event identity
conflict"). Five sessions (turns 20629, 20690, 20720, 20779, 20784) already started later turns
while the earlier agent still runs in the same Claude conversation; those old agents are a
second writer to that conversation and should be stopped or explicitly settled. The launch case
(a fresh run finding no CLI mid-reinstall) still fails its turn instead of retrying.

The follow-up recovery takes back a parked native turn when its host answers or has a recorded
exit and no later turn was admitted to the provider in that session. It retains the original run
and dispatch attempt and gives recovered run and terminal facts distinct identities that survive
another Concierge restart. Queued later turns wait; a recovered answer raises fresh attention.
Older parked turns with admitted later turns
are excluded from adoption; their hosts are stopped and their old turns marked interrupted after
provider exit, keeping the later turn in place. Concierge rechecks parked custody each minute
while online, so another parked live host does not wait for a restart.

A fresh Claude launch checks for the installed command before recording provider admission.
When a command replacement makes it unavailable, the turn is safely requeued under its own bounded
local-command retry budget without consuming the Claude account's provider retry budget. A host's
recorded spawn error also proves that a command lost after preflight never started. This prevents
the fresh-launch failure while keeping possibly active turns under execution-host custody.
The separate agent-shell launcher also waits for a command replacement; see
`docs/incidents/2026-11-04-claude-command-install-gap.md`. The journal did not identify the
installer, but the retained Codex transcript does, as recorded above.

## Acceptance scenario

- **Seed:** a running Claude turn with a live execution host; `claude` absent from PATH.
- **Action:** restart Concierge so it adopts the run.
- **Expected:** the run is adopted live (`execution_host_attached`, provider running) and is not
  parked; the agent's router-actions calls keep working.
- **Replayable offline:** no (needs an execution host under systemd and a coordinator restart).

For a fresh launch, start a native Claude turn while the command is absent before provider
admission, or remove it after preflight but before the host spawn. The expected outcome in both
cases is a queued retry under that turn's local-command budget, with no provider process or
acknowledgement. If the command stays absent through the bounded budget, the request fails
visibly and remains recoverable. Agent-run tests are disabled; source review and installed
observation are recorded separately.
