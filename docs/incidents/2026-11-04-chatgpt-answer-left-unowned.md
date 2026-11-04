---
failure: An agent's task could finish while its exact ChatGPT question had no delivered and handled answer.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# A ChatGPT answer was not a condition of finishing its asking task

## What was seen

Tejas could not open two agent-created ChatGPT conversations and could not tell whether their answers were reaching the agents. Concierge records showed that answers did return, including long answers to the two research questions, but the asking task had no durable condition requiring their return and handling before it finished. A separate Pro request had also parked after an uncertain send. The affected ChatGPT.com pages were rate limited; that page refusal is tracked by Thinkering and is distinct from this Concierge task-ownership failure.

## Cause

Before this change, Concierge owned each question as a request and the browser owned a send receipt, but no record connected the exact question to the asking task's final disposition and answer-handling step. A terminal agent turn or failed request could therefore be mistaken for the end of the task's duty to receive and use the answer.

## Fix

Record an exact answer obligation when the question is admitted. Refuse task completion until the answer reaches the asking session and that agent records how it handled it. Keep the original question open through failed or ambiguous sends, use the retained browser receipt for safe recovery, and show persistent failures and repair state to the asking agent. A human Stop can withdraw the duty; a failed or needs-decision report can cite it while repair continues.

## Acceptance scenario

- **Seed:** An agent task has an admitted ChatGPT question with no confirmed answer return.
- **Action:** The agent tries to finish its task, then its ChatGPT send fails before Send or its answer returns.
- **Expected:** Completion is refused while the exact question is open. A proven pre-Send failure is retried on its original run for a finite episode and then shown as a repair case. An ambiguous send is reconciled without a replacement. A returned answer reaches the original asker and remains open until the agent records how it handled that answer.
- **Replayable offline:** yes (with an isolated Concierge ledger and retained provider receipts; the protected test gate currently refuses agent-run tests).
