---
failure: A resumed Google conversation's historical quota error was treated as a new refusal after later inputs completed work.
date: 2026-11-14
fix_commits: []
cause_status: confirmed
---

# Google reused a historical conversation error

## What was seen

Two resumed Antigravity inputs produced completed responses and tool activity, but Concierge treated each terminal `ERROR` as a fresh quota refusal. Both terminal records repeated the same quota reset message from an earlier conversation step, despite containing a current final response and no current error step. The inputs' effects were retained; they must not be replayed to obtain a new result.

## Cause

The CLI's terminal result contains conversation-wide status and error text. The adapter treated that aggregate as the outcome of the newest input, without matching it to the current `user_input` and response steps. The retained owner journal and native conversation steps show the quota error at step 6868, while the later inputs were picked up at steps 7209 and 7226, completed response steps 7225 and 7242, and had no intervening error-message steps.

## Fix

Attribute outcome to each picked-up input. A current error-message step remains a failure; otherwise a final response is complete only when the latest current work step is a completed indexed response, all current tools are finished, and its accumulated text equals the terminal response. An unmatched aggregate error is unconfirmed and its historical text cannot trigger quota handling.

## Acceptance scenario

- **Seed:** A resumed conversation's terminal result says `ERROR` and includes old quota prose; a later input has a completed response step whose accumulated text exactly matches that terminal response, with no current error step or active tool.
- **Action:** Replay the retained structured stream through the adapter in a disposable transport.
- **Expected:** The input completes from its own response; the historical quota text creates no quota hold or usage-disagreement notice.
- **Replayable offline:** yes (sanitized retained stream metadata and a disposable transport; no CLI or provider call).
