---
failure: The current machine copy guard refused the agent-ecology committee's direct open and twin help commands.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Committee help was mistaken for a ledger copy

## What was seen

The agent report `capture:d17bc8dd132e1442e2eaa23c9668a5de593e9186431d1c1edcfba24c9cc79d0f` said the direct `python3 scripts/committee.py open --help` and `twin --help` forms were refused before Python ran. The equivalent `python3 -m committee ... --help` forms worked. The installed machine wrapper reproduced the `open --help` refusal before this fix.

## Cause

The committee script has a read-only Concierge ledger lookup and an unrelated NotebookLM answer-evidence file copy. The guard read the whole script, joined those unrelated operations, and concluded that even argparse help would copy the live ledger.

## Fix

The current guard recognizes only the two direct help forms for the installed agent-ecology committee script and skips script-source inspection for them. It still checks the typed command, including any explicit live path or chained copy. Other committee actions retain source inspection. The already-allowed module help form explains why this narrow exception does not create a new route to execute this script's help path.

## Acceptance scenario

- **Seed:** Install the candidate guard on a server with the agent-ecology committee script and a live Concierge ledger.
- **Action:** Run the committee's `open --help` and `twin --help` forms through the machine command wrapper, then submit a raw copy command naming the live ledger.
- **Expected:** Both help forms pass the wrapper and print argparse help; the raw copy is refused before execution. A chained copy after `open --help` is also refused.
- **Replayable offline:** yes (the focused fixture checks the policy; the installed wrapper check covers the real command path).
