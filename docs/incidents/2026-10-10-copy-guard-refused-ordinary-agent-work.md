---
failure: The new guard against raw copies of the live database refused agents' ordinary replies and everyday scripts.
date: 2026-10-10
fix_commits: [4dcdfd15, 7919d3dd, 7e26df4f, e29bba17, f9a3c8d1]
cause_status: confirmed
---

# The live-database copy guard refused ordinary agent commands

## What was seen

After a60ee907 and 7541436f installed a pre-command refusal of raw live-ledger copies and inherited-live code launches
on October 10, agents' `sessions reply` commands were refused when the reply text contained words such as "install", and
ordinary Python or Node scripts were refused. Old running agents kept being refused even after the first fix.

## Cause

- `bot/src/live-store-copy-policy.ts` found the owner path inside the session helper command and scanned quoted reply text
  as shell, so words in prose matched copy executables.
- `bot/scripts/live-store-copy-guard.ts` treated any Python or Node launch as a possible ledger import, because provider
  shells inherit the owner path for request routing.
- Running agents carried pinned history hooks with the old raw-copy decision, which repeated the refusal after the
  current machine guard allowed the command.

## Fix

4dcdfd15 recognizes copy executables only at shell command positions and treats a standalone session-helper call as an API
request. f9a3c8d1 limits the inherited-state refusal to package runners that can load Concierge modules before scratch
setup. 7919d3dd runs the current check first and suppresses only the old pinned duplicate; 7e26df4f keeps other pinned
semantic refusals; e29bba17 resolves the installed release before locating pinned hook bundles.

## Acceptance scenario

- **Seed:** The installed pre-command hook plus an older pinned history hook; owner path in the environment.
- **Action:** Run `router-actions.sh sessions reply <id> --text "install finished; copied the notes"`, `python3 parse.py`,
  and `sqlite3 <live state.db> ".backup /tmp/x"`.
- **Expected:** The first two run; the third is refused with the snapshot-entrance pointer.
- **Replayable offline:** yes (hook fixtures with a scratch state path)
