---
failure: When work moved from Claude to Codex because Claude ran out, the system's "Continued in a Codex session" line was shown as Claude's own reply.
date: 2026-10-13
fix_commits: [74066225]
cause_status: confirmed
---

# The Claude-to-Codex hand-off line appeared as something Claude said

## What was seen

On 2026-10-13 Tejas saw "Continued in a Codex session after Claude usage ran out." in a conversation, shown as
a reply from Claude, and asked how Claude could answer when it had run out.

## Cause

At a confirmed Claude allowance wall, the transfer in `bot/src/provider-exhaustion-recovery.ts` cancels the
source Claude turn, moves its accepted input to a Codex successor, records a `provider_recovery` event
(`event_id provider-recovery:<inputId>`, reason `claude_usage_exhausted`) and writes the hand-off sentence
into the cancelled turn's `agent_text`. The ledger history projection in `bot/src/session-owner.ts` renders
every turn's `agent_text` as an assistant message authored by the session's agent, so the owner's own line was
attributed to Claude, which never ran.

## Fix

74066225: new `movedToCodex(inputId)` reads the `provider_recovery` event the transfer already records. The
history projection authors a moved turn's text as `{kind:'service', communication:'notice'}` instead of the
agent. Because it reads existing events at read time, turns moved before the change are corrected without
rewriting them. `docs/architecture/PROVIDER-SESSIONS.md` records the rule.

## Acceptance scenario

- **Seed:** A Claude session with a cancelled turn whose accepted input has a `provider_recovery` event with
  reason `claude_usage_exhausted` and whose `agent_text` is the hand-off sentence; a second ordinary turn with
  a real Claude reply.
- **Action:** Read the session's ledger-backed history.
- **Expected:** The hand-off sentence has author kind `service` with communication `notice`; the ordinary
  reply keeps the agent author.
- **Replayable offline:** yes (scratch ledger rows only)
