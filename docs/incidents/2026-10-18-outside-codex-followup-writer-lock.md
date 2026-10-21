---
failure: A follow-up request to an outside Codex agent failed before starting, because Concierge's shared Codex server had taken hold of that agent's conversation.
date: 2026-10-19
fix_commits: [7434c343, 57907c51]
cause_status: confirmed
---

# A follow-up to an outside Codex agent failed: its conversation was locked by the shared server

## What was seen

On 2026-10-19 (UTC; late on the 18th Eastern) a follow-up request to an outside Codex session, the kind asked for
with `sessions ask --outside` so it survives Concierge restarts, failed before starting a turn. The CLI reported that
the thread already had an active writer. The shared Codex App Server held the writer lock for that conversation
(`docs/architecture/PROVIDER-SESSIONS.md`, "Outside Codex conversation ownership").

## Cause

An outside turn runs `codex exec` in its own execution host (`bot/src/outside-codex.ts`); each follow-up launches a new
CLI process against the same rollout, which must be the sole writer. But the shared App Server observer chose the
sessions to watch from `listUniqueCodexSessionBindings` / `getUniqueCodexSessionBinding` in `bot/src/state.ts`, which
did not exclude outside sessions. Its startup sweep and new-binding subscription therefore called `thread/resume` on
the outside conversation, and `thread/resume` loads a writer even with `excludeTurns`. The daemon kept that writer
while the thread stayed loaded, so the next CLI process was refused. The refusal also surfaced as a generic
"Codex ended with code 1" error, eligible for the account-wide Codex retry budget, so one conversation's lock could
count against every Codex session.

## Fix

- 7434c343: both binding queries skip sessions whose metadata has `outside`, so the observer never resumes them. A CLI
  "already has an active writer" refusal is typed (`isCodexThreadWriterConflict` in `provider-failures.ts`), marked
  terminal-confirmed when nothing ran, and `turn-execution.ts` keeps it out of the account-wide transient retry budget.
- 57907c51 (follow-up of the same change): lifecycle observations recorded on outside sessions before the exclusion
  are ignored by `session-presence.ts` and by the unmanaged-server repair gate in `provider-activation.ts`, so a stale
  "running" cannot make the session look busy or block a repair; the refusal message tells the sender to retry after
  the writer releases.
Remaining limit: a conversation the App Server loaded before the fix may stay locked until it releases the idle thread.

## Acceptance scenario

- **Seed:** A Codex session with `outside: true` metadata and a bound thread UUID whose first turn has completed; the
  shared App Server (or a stand-in recording `thread/resume` calls) running with the observer.
- **Action:** Restart Concierge (startup sweep), then send the session a follow-up request.
- **Expected:** The observer issues no `thread/resume` for that thread; the follow-up CLI process starts its turn. If a
  stand-in CLI prints the active-writer refusal, the request fails with the typed message and the Codex retry breaker
  is unchanged.
- **Replayable offline:** no (the real writer lock needs a real Codex App Server and CLI; observer selection and
  failure typing alone are replayable with stand-ins)
