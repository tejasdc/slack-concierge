---
failure: The shared Codex background server died when the terminal login that had happened to start it closed, cutting off Codex conversations.
date: 2026-10-08
fix_commits: [73731ada]
cause_status: confirmed
---

# Codex's shared server died with whatever started it

## What was seen

At 6:47 AM EDT on 2026-10-08 the shared Codex App Server died when the SSH login that had started it closed.
Its replacement was started inside an agent's execution host, and the one after that by Concierge's own
account switch inside `concierge-bot.service`, which every update restarts. Each placement made Codex
conversations vulnerable to an unrelated stop.

## Cause

Confirmed from 73731ada. systemd ends every process in a unit's cgroup when the unit stops, and a detached
daemon stays in the cgroup of whoever started it. Any `codex` command can start a stopped daemon (an SSH
login, an agent's run, the bot), so the daemon's lifetime was tied to an arbitrary unrelated unit.

## Fix

73731ada: `moveCodexDaemonToOwnScope` in `codex-daemon-file-limit.ts`, called from
`codex-app-server-client.ts` on every connection, finds daemon roots (excluding per-client proxies) not already
in a `codex-app-server-*.scope`, collects their descendants, and moves them via systemd
`StartTransientUnit` into a new `codex-app-server-<pid>.scope` with `CollectMode=inactive-or-failed`. A
concurrent connection that already moved them is tolerated; a failed move logs
`codex_daemon_scope_move_failed`. Documented in CODEX-APP-SERVER.md ("The daemon lives in its own scope").

## Acceptance scenario

- **Seed:** start the Codex daemon from inside a transient unit or an SSH session scope.
- **Action:** Concierge connects to the App Server, then the starting unit or session is stopped.
- **Expected:** after the connection the daemon's cgroup is `/system.slice/codex-app-server-<pid>.scope`
  (`codex_daemon_moved_to_own_scope` logged); stopping the original unit leaves the daemon PID alive and
  `model/list` still answers.
- **Replayable offline:** no (needs systemd and a real Codex daemon on a Linux host)
