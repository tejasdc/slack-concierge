---
failure: The repair agent could not ask Tejas anything, because its runbook told it to quote the alert as his words and Concierge refused every such question.
date: 2026-10-10
fix_commits: [202eb6d2]
cause_status: confirmed
---

# The repair agent's questions to Tejas were always refused

## What was seen

When the repair agent found something only Tejas could fix, its `needs_you` declaration failed to send, so the issue
never reached his Needs attention list.

## Cause

`needs_you` requires `--his-words`, and the owner verifies the quote against his own recent messages in the ledger
[decision: questions-carry-his-words]. `docs/runbooks/REPAIR-AGENT.md` told the repair agent to quote the notice it was
working, which is service text, so the owner refused every question.

## Fix

202eb6d2 corrects the runbook: quote one of his actual messages, or declare a `response` (which still raises Needs
attention) when there is none. An instruction-only fix; no code enforces the runbook.

## Acceptance scenario

- **Seed:** The standing repair agent session working a provider-free repair notice; no recent message from Tejas about it.
- **Action:** The agent follows its runbook to escalate.
- **Expected:** The escalation is accepted (as a `response` or with a real quote) and appears in Needs attention; no
  refused outcome in the log.
- **Replayable offline:** no (depends on a model following the runbook; the refusal rule itself is replayable)
