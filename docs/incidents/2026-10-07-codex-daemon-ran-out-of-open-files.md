---
failure: An update restart failed because the shared Codex background service, started from a terminal login, ran out of open files.
date: 2026-10-07
fix_commits: [08672901]
cause_status: confirmed
---

# An update restart failed when Codex ran out of open files

## What was seen

The 7:24 PM update restart on 2026-10-07 failed. The shared Codex daemon had been started at 6:39 PM by a
`codex` command in an SSH login and could not open its own settings file while Concierge re-followed its
conversations after the restart.

## Cause

Confirmed from the commit message and code comment. The daemon's open-file limit is inherited from whoever
starts it. Started by Concierge it inherits the service's high limit; started by the first `codex` command in
an SSH login after it had stopped, it inherits that login's soft limit of 1,024. The daemon holds files open
for every conversation Concierge follows, and re-following all of them after a restart exhausted 1,024.

## Fix

08672901 adds `bot/src/codex-daemon-file-limit.ts`: every time `CodexAppServerClient.createConnection` runs,
Concierge finds the long-lived `codex app-server` processes (not per-turn `--stdio` children) in `/proc`,
reads their `Max open files`, and uses `prlimit` to raise the soft limit to the hard limit when it is lower,
logging `codex_daemon_file_limit_raised` (or `codex_daemon_file_limit_unraised` on error). Who starts the
daemon cannot be controlled, so the connection side corrects it. `AGENTS.md` records the rule.

## Acceptance scenario

- **Seed:** a Codex app-server daemon started from a shell with `ulimit -n 1024`, with a hard limit above that.
- **Action:** Concierge connects to it (startup or reconnect).
- **Expected:** `/proc/<pid>/limits` for the daemon shows soft equal to hard, `codex_daemon_file_limit_raised`
  is logged once, and following many conversations after a restart does not hit EMFILE; if `prlimit` is
  unavailable the failure is logged, not silent.
- **Replayable offline:** yes on Linux (start a stand-in process named `codex app-server` with a low soft
  limit; no real Codex or account needed)
