---
failure: A ChatGPT question that was never sent stayed blocked because an earlier, unrelated ChatGPT refusal had already used up the shared retry allowance.
date: 2026-10-12
fix_commits: [ef57e633, 5f97106e]
cause_status: best-explanation
---

# A previous ChatGPT refusal blocked a different question that had never been sent

## What was seen

A ChatGPT request interrupted before anything reached the browser (Thinkering restarting, the capability
briefly disconnected) was parked as a terminal failure instead of being tried again. After the first fix,
a different never-sent question still did not retry when an older ChatGPT refusal was on record. Tejas
saw requests that had provably never been sent stay failed.

## Cause

Two layers, both in the ChatGPT dispatch path.

1. `ChatGptDispatchError` in `bot/src/session-capability-client.ts` classed every capability failure as
   `parked_terminal`, including the receipts `CHATGPT_NOT_SENT` and `CHATGPT_SEND_FAILED`, which prove no
   browser dispatch happened. The start loop also retried only `SESSION_OWNER_UNAVAILABLE`, not
   `CAPABILITY_DISCONNECTED`, `CHATGPT_CAPABILITY_UNAVAILABLE` or HTTP 503.
2. Once those became `retryable`, `executeAgentTurn` in `bot/src/turn-execution.ts` recorded the retry
   against `providerBreakerKey`, which for ChatGPT is the single account-wide key `provider:chatgpt:profile`.
   An earlier terminal refusal for another turn left that breaker stopped, so the safe retry of this turn was
   suppressed. Best explanation from the diff and the commit pair: the second commit followed because the
   first was seen not to retry in the presence of an old refusal; the live breaker state was not observed here.

## Fix

- ef57e633: the exact `prepared` receipt with `CHATGPT_NOT_SENT` or `CHATGPT_SEND_FAILED` and no uncertainty is
  classed `retryable`; the start loop also retries on capability disconnect, capability unavailable and 503,
  reusing the same run id so an already dispatched effect is returned unchanged and only a never-dispatched
  receipt is rearmed. Acknowledged or ambiguous failures stay terminal.
- 5f97106e: a never-sent retry uses its own per-turn breaker key (`...:turn:<turnId>`), cleared on success, so an
  older account-wide refusal cannot suppress it. Documented in AGENTS.md and docs/architecture/SESSION-OWNER.md.

## Acceptance scenario

- **Seed:** The ChatGPT profile breaker holds a terminal (stopped) failure from an earlier turn. A second
  ChatGPT turn is queued whose browser send never happens (capability host returns `CHATGPT_NOT_SENT`).
- **Action:** The second turn is dispatched and the capability host reports the never-sent receipt.
- **Expected:** The turn stays queued and retries under its own bounded per-turn budget, then runs once the
  host accepts it; it is not parked failed and does not consult the old breaker. A turn whose receipt is
  ambiguous or already dispatched is not re-sent.
- **Replayable offline:** yes (stub capability client returning the receipts and a seeded retry breaker row)
