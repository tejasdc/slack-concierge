---
failure: A marked Codex side question failed because the runner could not find its completed conversation.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# A Codex side question could not find its conversation on the runner

## What was seen

After the reusable side-question fork release was installed, an agent-marked test conversation
(`concierge:9259`) completed a final answer. Asking a side question through thnkr.ing returned a
failed exchange. The owner route answered 502 with “The exact provider conversation is unavailable
on this runner.” No provider fork was made.

## Cause

The runner's exact transcript lookup accepted a bare UUID filename or a filename consisting only
of a hyphen plus UUID. Codex writes files named `rollout-<timestamp>-<UUID>.jsonl`. The marked
conversation's file existed in the active Codex home and was uniquely found by a read-only
filesystem search, but the lookup rejected its actual filename.

## Fix

Recognize the exact UUID as the final filename component after Codex's timestamp prefix. Keep
the existing credential-verified home selection and physical-file uniqueness rule, so a similar
filename elsewhere cannot silently select an account.

## Acceptance scenario

- **Seed:** A marked Codex conversation has a completed final answer and a rollout file with Codex's normal timestamp prefix.
- **Action:** Ask a side question from a passage of that answer.
- **Expected:** The runner resolves the exact original conversation and the side question answers from its saved fork; a second question reuses that fork.
- **Replayable offline:** yes (a runner account fixture can create the normal filename, but final proof is the installed marked conversation).
