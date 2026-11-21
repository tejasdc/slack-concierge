---
failure: A group chat member on GPT-6.2 Astra never answered; Concierge swapped it to Sol and the group refused the swap.
date: 2026-11-21
fix_commits: []
cause_status: confirmed
---

# The Codex member of his storytelling group failed before answering

## What was seen

Tejas asked for a group chat with the newest Codex and Claude models on his storytelling
brainstorm (Nov 21, 3 AM Eastern). The group started with Claude Fable 5.2 and GPT-6.2 Astra.
The Claude member began answering; the Codex member's first turn ended at once with
"The prepared Lab execution differs from the selected provider, model or effort; no replacement
was sent." (owner log `native_provider_refused`, 07:59:14 UTC, session concierge:10238).

## Cause

When a group adds a member, the Lab records the model choice as a `model_escalation` event against
the group's membership input. The Astra turn gate looks for a choice only on the turn's own
accepted input, which for a group member is a separate Lab invocation. It found none, so it
dispatched the turn on Sol. The Lab's binding check then compared the dispatched model with the
member's bound model, saw Sol ≠ Astra, and refused the run. Every Astra group member was affected,
whether he or an agent started the group.

## Fix

For a bound Lab invocation the gate reads the member's membership choice and keeps Astra when the
Lab recorded his explicit choice or a retained one.

## Acceptance scenario

- **Seed:** a Lab group with one new member on `gpt-6.2-astra` (provider codex).
- **Action:** the group's opening invocation is dispatched to that member.
- **Expected:** the turn runs on `gpt-6.2-astra`, no `model_substitution` event is recorded, and
  the member's answer is published to the group.
- **Replayable offline:** no (needs a Codex account with Astra room).
