---
failure: Conditional human wording allowed an immediate Astra start without an escalation reason.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Conditional model choice became immediate authority

## What was seen

The final model-policy review reproduced that “Use GPT-6 Astra only after three failed fixes” and a condition wrapped onto the line before “use GPT-6 Astra” both counted as an explicit human model choice. That choice bypassed the escalation reason and exempted the session from the fifth-edit handoff decision.

## Cause

The human-choice classifier split statements at line breaks and did not recognize ordinary “after” or “once” conditions on either side of a model directive.

## Fix

Keep line-wrapped clauses together and reject conditional clauses before granting model, provider or effort choice authority.

## Acceptance scenario

- **Seed:** Retained human text says “Use GPT-6 Astra only after three failed fixes and ChatGPT Pro has failed,” “Once ChatGPT Pro has failed three times, use GPT-6 Astra,” or “If needed,\nuse GPT-6 Astra.”
- **Action:** An agent asks to start Astra with no escalation reason.
- **Expected:** The text does not qualify as an explicit human choice, so the normal escalation reason check refuses the request. A direct “Use GPT-6 Astra” still qualifies.
- **Replayable offline:** yes (the focused model-choice custody check exercises the shared classifier for model, provider and effort choices).
