---
failure: An agent's search for a process crawled every process's working folder and stalled the server for minutes.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# One agent search slowed Concierge, thnkr.ing and every agent

## What was seen

From 00:49 to 00:53 ET a Codex agent in the shared Codex App Server ran
`rg -n 'journal-save-crash-proof|journal-probe' /proc/[0-9]*/cwd /proc/[0-9]*/cmdline`. It ran for
4.5 minutes at about 493% CPU, load went from 20 to 38, and the outside monitor's slowdown
incident reopened. The repair agent killed the search.

## Cause

Each `/proc/<pid>/cwd` is a link to that process's working folder (often `/` or the workspace).
ripgrep follows links named on its command line, so it searched those whole trees once per
process. Nothing refused that command before it ran.

## Fix

The pre-command check that every Claude and Codex agent runs (the machine hook's current-release
pass, plus the pinned history guard) refuses a recursive search (rg, grep -r, find, fd, ag, ack,
ls -R, tree, Claude's Grep and Glob) that starts at `/`, `/proc` or a process's
`/proc/<pid>/cwd|root|fd`. Depth-bounded looks (`find / -maxdepth 2`, `rg --max-depth 2`), named
folders, `/proc/<pid>/cmdline`, `pgrep` and `ps` stay allowed. The refusal names those
alternatives. Policy: `bot/src/whole-machine-crawl-policy.ts`.

## Acceptance scenario

- **Seed:** an agent shell on the server with Concierge's machine hooks installed.
- **Action:** the agent runs `rg -n foo /proc/[0-9]*/cwd /proc/[0-9]*/cmdline`.
- **Expected:** the command is refused before it starts, with a reason naming `pgrep -af` and
  `readlink /proc/<pid>/cwd`; `rg -n foo /proc/[0-9]*/cmdline` still runs.
- **Replayable offline:** yes (the policy is a pure function of the command text).
