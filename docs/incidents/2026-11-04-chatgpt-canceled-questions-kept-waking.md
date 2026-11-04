---
failure: Canceled and superseded ChatGPT questions kept waking their asking agent.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Canceled ChatGPT questions kept waking their asker

## What was seen

On November 4, the answer-obligation release admitted repair inputs for three ChatGPT requests that their asking session, concierge:8245, had already canceled. The requests were 607c944a-3211-4f28-92f5-e686b612c680, 01a4bd5f-6bcf-436f-9d66-9cfa428b8e32, and 03402990-1bc0-44a9-bac0-6e9521983bed. A fourth failed, garbled request, c4e9790c-bb06-4e7d-9237-831b6b7f76e1, was superseded by later answers but also generated repair. The asking agent had to cancel the three requests again. The original provider attempts were not resent.

## Cause

The repair loop checked the obligation and the asker's availability, but did not read the exact request's completed cancellation action. A canceled request therefore remained an open duty. The failed request had no supported way to cite later answers as satisfying its question.

## Fix

The owner now closes an obligation only when it finds a completed cancellation action from the exact asking session for that canceled request. It applies this at cancellation, before each repair admission, and once at startup for historical cancellations. A separate successor-answer disposition requires the asking session to cite a received ChatGPT answer event from its own later request and explain how that answer covers the earlier question. The failed attempt remains retained as evidence.

## Acceptance scenario

- **Seed:** An asking session has an unanswered ChatGPT request and its answer obligation.
- **Action:** The asking session cancels the request with a retained action.
- **Expected:** The question closes as withdrawn by that asker and no repair input is admitted after its due pass. The three historical canceled requests close at startup. The failed fourth request closes only after the asker cites a received successor answer and coverage reason. A failed request without such evidence remains open.
- **Replayable offline:** yes (with a synthetic owner ledger and captured cancellation and answer identities).
