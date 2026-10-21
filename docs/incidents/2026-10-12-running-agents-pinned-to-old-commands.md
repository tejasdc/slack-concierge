---
failure: Agents that had been running since before an update could not use newly added session command options, so their requests and replies were refused or bypassed the new behaviour.
date: 2026-10-12
fix_commits: [d7dcd57e, 7d89b697, e3c8198c, e9be61a8]
cause_status: confirmed
---

# Long-running agents used a stale command parser

## What was seen

- Observed, October 9 live test: a running agent's new `sessions ask` did not use the just-installed automatic
  Claude/Codex choice (d7dcd57e "closes the gap found in the live test").
- Observed, October 12: a live marked question reached a busy recipient whose command parser rejected the new
  `--answers-question` flag (e9be61a8).
- Same mechanism, fixed pre-emptively per their messages: the new Lab board reply option (7d89b697, October 10) and
  Google-bound saved work (e3c8198c, October 12) for sessions that predated the update.

## Cause

A running session keeps the router helper bundle pinned to the release it started under. `systemd/router-actions.sh` sent
its commands to that pinned `router-sessions.js`, whose argument parser predates any option added later.

## Fix

d7dcd57e routes server `ask` to the installed current bundle; 7d89b697 adds `board`; e3c8198c adds `bank` and `schedule`;
e9be61a8 routes every server session command through the installed release. Mac commands keep their local installation.

## Acceptance scenario

- **Seed:** A session started under release N with its pinned helper; release N+1 installed with a new `sessions reply`
  flag.
- **Action:** From that session's shell, run the router helper with the new flag.
- **Expected:** The command is parsed by release N+1 and accepted.
- **Replayable offline:** yes (two release directories and the launcher script)
