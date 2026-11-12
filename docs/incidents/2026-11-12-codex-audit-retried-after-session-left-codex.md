---
failure: The leftover-process check for one Codex turn failed every minute from Nov 11 07:05 UTC onward, because its session had moved to another provider.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# A Codex process check failed once a minute for a day and a half

## What was seen

From 2026-11-11 07:05 UTC, concierge-bot logged `codex_process_audit_recovery_failed` for turn
25292 ("Codex process audit intent has no turn.") on every minute sweep: 371 times in the six hours
before the report, and the Inbox agent report saw it again at 21:55–21:59 UTC on Nov 12. No other log
line names that turn.

## Cause

Confirmed in code; the live turn row could not be read from an agent shell, which hides the ledger.
The sweep selects only audit intents whose turn exists and has finished, but the audit then looked
the turn up joined to a session whose provider is still Codex. A Codex refusal of a new session's
first turn, for model capacity or for allowance, moves that session to another provider, clears its Codex thread and retries the
same turn there. Its intent, written while it was Codex, then matched the sweep and never matched the
audit, so it threw the same error every minute with no final cause. This is the only path in the
code that changes an existing session's provider. Which of the two refusals moved turn 25292 is not
known; the fix does not depend on it.

## Fix

The audit reads the turn regardless of provider. When the session is no longer Codex, it records the
audit as done with the cause `session-left-codex`: no Codex thread remains to name, and both
reroutes run only inside the dispatch-failure path that already requires no tool use, no output and
no files from the attempt, so no Codex process can be left. An audit whose runner stays unreachable
still retries without a final cause; that retry is intended and unchanged.

## Acceptance scenario

- **Seed:** a Codex session with one finished turn, its audit intent and terminal event; the session then
  moved to Claude Code with no thread.
- **Action:** run the audit sweep twice.
- **Expected:** one `codex-process-audit-done` record with reason `session-left-codex`, no error; the old
  code logs the reported error and records nothing (`bot/scripts/codex-audit-off-codex-fixture.ts`).
- **Replayable offline:** yes
