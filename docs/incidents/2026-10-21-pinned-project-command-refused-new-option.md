---
failure: An agent that started before an update could not create a project, because Concierge required the new who-is-it-for option while the agent's own copy of the project command refused it.
date: 2026-10-21
fix_commits: []
cause_status: confirmed
---

# An agent could not create a project after the update

## What was seen

On 2026-10-21 the update that made `project new` require `--owner tejas|agents` installed on the
server. A session whose run began before that update called `router-actions.sh projects new`:
without `--owner` the owner refused ("Say who the project is for"), and with `--owner` the
command itself refused ("Invalid project option: --owner"). It worked only by pointing
`CONCIERGE_ROUTER_BOT_DIR` at the source checkout by hand.

## Cause

A running agent's environment pins `CONCIERGE_ROUTER_BOT_DIR` to the release that launched it.
The launcher already sent `sessions` commands to the installed release for exactly this reason
(a reply option on 2026-10-12), but `projects`, `external` and `work` still ran the pinned copy,
whose parser predated the new option. The owner is always the installed release, so a pinned
client can disagree with it in both directions.

## Fix

Every launcher entrance that talks to the owner (`sessions`, `projects`, `external`, `work`)
runs the installed release's client on the server, falling back to the pinned copy only when no
installed one exists. Hooks stay pinned to their run. The Mac keeps its local installation.

## Acceptance scenario

- **Seed:** a server agent whose `CONCIERGE_ROUTER_BOT_DIR` names an older release without
  `--owner`, while the installed release and owner require it.
- **Action:** the agent runs `router-actions.sh projects new <name> --owner agents --here-only --purpose "<sentence>"`.
- **Expected:** the project is created in `workspace/agents/<name>`; no "Invalid project option" refusal.
- **Replayable offline:** yes (set `CONCIERGE_ROUTER_BOT_DIR` to an older release directory and run the command).
