---
failure: The database copy guard refused an agent's Concierge message because the message mentioned a copy command and its output was piped.
date: 2026-10-16
fix_commits: [2fd05d0e]
cause_status: confirmed
---

# A piped router message about database copies was refused as a copy

## What was seen

On 2026-10-16, while the ledger copy guard was being repaired, a repair agent's `router-actions.sh
sessions reply …` was refused as a live-database copy. The command's text mentioned `.backup` and
`cp`, and its output was piped to `head`. The refusal was at first misread as the old guard already
recognising the ledger's new path.

## Cause

`liveStoreCopyRefusal` in `bot/src/live-store-copy-policy.ts` lets a standalone router call through
without inspection. A router call followed by a pipe is not standalone, so the guard fell back to
`mentionedScripts`, which reads the files a command names and adds their text to what it inspects.
That included `router-actions.sh` itself, and the helper's own text names the state directory. The
combined text then held a live-store reference (from the helper) and a copy word (from the message),
so any piped router message that only talked about `.backup` or `cp` matched as a live copy.

## Fix

2fd05d0e skips the router helper in `mentionedScripts`, as it already skipped the snapshot entrance,
so the helper's own text never counts as part of the command. A copy chained after the router call
is still refused, because the guard checks the command text itself. The fixture
(`bot/scripts/live-store-copy-guard-fixture.ts`) covers both: a piped reply mentioning ".backup and a
plain cp" is allowed, and `sessions list | head; cp <live db> /tmp/…` is refused.

## Acceptance scenario

- **Seed:** The installed guard and a router helper whose text names the state directory.
- **Action:** Run `router-actions.sh sessions reply <id> --summary "Guard fix" -- "a .backup and a plain cp got through" | head -c 200`.
- **Expected:** The command is allowed. `router-actions.sh sessions list | head; cp
  ~/.local/state/concierge/state.db /tmp/x.db` is refused.
- **Replayable offline:** yes (the guard fixture evaluates command strings against scratch files)
