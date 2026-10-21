---
failure: A request to a new session was marked failed with "The exact session binding changed." while that session, moved to another provider, was still answering it.
date: 2026-10-16
fix_commits: [f76d6070]
cause_status: confirmed
---

# A moved new session's request was closed as failed while it was still being answered

## What was seen

During the OpenAI capacity episode on 2026-10-16 (from 03:48 ET), an Automatic session whose first turn was refused for
capacity was moved from Codex to Claude, and its turn ran and answered. Meanwhile request `10183b3a`, the request that
session had been created to answer, was settled failed with "The exact session binding changed.", so the requester was
told the work failed although it was in progress.

## Cause

`moveAutomaticFirstTurnOffRefusingModel` in `bot/src/turn-execution.ts` (5743725e) keeps the session, input and request
IDs but changes the provider and bumps `sessions.binding_generation`. The open-request sweep in
`session-communication.ts` (`dispatch`), which runs on every execution change, decoded the request's stored address
again with `this.address(JSON.parse(request.payload_json).address)`. That address is pinned to the generation it was
asked at, so after the bump the decode threw and the catch settled the request `failed` with the thrown message. The
request already had `target_input_id`, the input the target session had retained, which was still valid. Recorded in
docs/architecture/PROVIDER-SESSIONS.md by f76d6070.

## Fix

f76d6070: when `target_input_id` resolves to an accepted input in `target_session_id`, `dispatch` targets that
session directly and decodes the address only when the retained input is gone. A request is pinned to the input its
target retained, never to the address generation the move changes. AGENTS.md records the rule.

## Acceptance scenario

- **Seed:** An Automatic Codex session created by an agent request (request row with `target_input_id` and
  `target_session_id`), Claude with room, and a stub Codex that acknowledges the first turn and ends it with a
  capacity refusal.
- **Action:** Dispatch the first turn so the owner moves the session to Claude (binding generation +1), then let the
  open-request sweep run on the resulting execution change.
- **Expected:** The request stays open, the moved turn runs on Claude, and the request settles only from that turn's
  own `sessions reply`; no settlement carries "The exact session binding changed."
- **Replayable offline:** yes (stub providers; ledger and owner only)
