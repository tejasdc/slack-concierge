---
failure: Agent requests, reminders and notices sent to Astra-bound Codex sessions ended without Codex recording them, so the work looked silently dropped.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
replayable: true
installed_acceptance: pending
---

# The Astra check silently blocked agent work

## What was seen

Codex turns on GPT-6 Astra ended empty and Concierge parked them as
CODEX_INPUT_NOT_ACKNOWLEDGED (sessions 8245, 3081, 3558). Third recurrence since the Astra
prompt check shipped on 2026-11-12.

## Cause

The managed prompt hook asks the owner whether an Astra prompt is allowed. Only Tejas's own
input, a continuation of his choice, a custody placement or a prompt with a qualifying
escalation reason passes; agent requests, reminders and notices to agent-bound Astra
sessions are refused. The hook answers `block`; Codex then discards the reason and
completes the turn without recording the input. Concierge had sent a turn it would itself
refuse, and the refusal left no trace on the owner side.

## Fix

One owner decision (`astraAllowedForTurn`) serves both the hook and dispatch. Dispatch asks it
first and runs a refused turn on GPT-6.1 Sol for that turn only (model sent on the turn
start), recording `model_substitution`. The hook's denials are recorded as
`model_start_denied` and the parked turn's status names the Astra check and its reason.
The policy is unchanged [decision: chatgpt-pro-is-the-big-guns].

## Acceptance scenario

- **Seed:** an Astra-bound Codex session with an agent-authored input, a human-authored input and an input carrying a qualifying escalation reason.
- **Action:** dispatch each turn, and ask the prompt gate about the agent turn twice.
- **Expected:** the agent turn is dispatched on gpt-6.1-sol with one `model_substitution` event; the other two stay on gpt-6-astra; the gate still refuses the agent turn, records exactly one `model_start_denied`, and the parked status names the Astra check and its reason.
- **Replayable offline:** yes (`bun run scripts/astra-dispatch-substitution-fixture.ts`)
