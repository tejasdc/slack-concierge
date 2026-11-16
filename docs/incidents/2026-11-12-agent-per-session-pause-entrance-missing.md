---
failure: An authorized native agent experiment could not Pause and Continue one disposable session without using a human action or pausing unrelated work.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Agent per-session Pause entrance was missing

## What was seen

The marked Thinkering agent entrance refused a session action with AGENT_DOOR_CLOSED.
The router offered global Pause and global resume controls but no single-session
equivalent. The experiment needed disposable native Claude sessions on the server
and Mac. A global control would disturb unrelated work; a human action would give
the agent's action the wrong author.

## Cause

The owner already implemented per-session suspension and continuation for human
controls, but their persistence context always recorded human origin. The agent
router did not have a typed, source-checked sibling for those controls.

## Fix

Add a local exact-address agent command for Pause and Continue. Use existing live-run,
work-authority and handoff checks, existing owner action semantics and retained action
idempotency. Retain agent origin, acting session, exact source input/run and target
address with the control event. No human route is opened to agents, no global state
is changed, and no peer protocol or automatic release policy is added.

## Acceptance scenario

- **Seed:** An admitted native controller run with work authority and two disposable
  native Claude sessions on one Concierge instance; repeat on the Mac after installation.
- **Action:** Discover the target address, Pause it through the agent command, submit
  ordinary work to it, then Continue it using a new stable action ID.
- **Expected:** Only the target becomes suspended. Its accepted work remains held
  until Continue, then enters the ordinary queue once. Control history records the
  agent's exact source and acting session. Global Pause and the other session remain
  unchanged. Repeating a command retains one operation; changed verb or target under
  the same source/action conflicts. Replaying an old Pause after Continue or an old
  Continue after another Pause does not reverse the later choice. Invalid or stale
  source, stale target binding, peer address, imported record and informational-only
  caller are refused without effect. A saved receipt is not provider interruption proof.
- **Replayable offline:** no (installed native server/Mac behavior requires those
  running owners and provider sessions; parser/build checks alone do not prove it).
