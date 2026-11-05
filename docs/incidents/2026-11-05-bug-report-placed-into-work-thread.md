---
failure: The Inbox router placed his bug report inside an open work thread and handed it to that thread's agent, breaking the rule that a bug report is always its own Inbox thread.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# His bug report showed up inside a work thread as a message to the agent

## What was seen

Nov 5, 4:36 AM ET: Tejas filed a bug report about an agent's answer on server load. It reached
the Inbox, then appeared inside "A server that stays responsive while agents work" as a message
to that thread's agent. His words: "What's the point of doing a bug report and having a different
keyboard shortcut if it's going to send it to a session agent? How are you breaking literal
invariants?"

## Cause

The router ran `sessions topics place <that thread> --root <bug report>`, then routed it to the
worker. Nothing in Concierge distinguished a bug report from any other capture when placing it;
only the router's own judgment upheld [decision: inbox-button-always-new-request]. The placement
prompt and the Stop hook even offered "file in an existing topic" for bug reports.

## Fix

The owner refuses (`BUG_REPORT_OWN_THREAD`) an agent's placement of a bug report beside any other
root: `topics place`, `topics create` with other roots, `topics route`, `topics merge` of its
topic and `sessions thread`. The placement prompt and the Stop hook offer only a new topic,
optionally linked with `--from`. See native-inbox "A bug report … is always a thread of its own".

## Acceptance scenario

- **Seed:** an unplaced Thinkering bug-report capture and an open topic holding another root.
- **Action:** the Inbox router runs `topics place <that topic> --root <bug report>`, or any agent runs `sessions thread <bug report> --thread <message in that topic>`.
- **Expected:** both are refused with the bug-report message; `topics create --root <bug report> --from <that topic>` succeeds.
- **Replayable offline:** yes
