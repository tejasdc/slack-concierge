---
failure: A ChatGPT question sent while Thinkering was restarting was set aside as possibly sent and never retried, although nothing had reached ChatGPT.
date: 2026-10-16
fix_commits: [6fc0064c]
cause_status: confirmed
---

# A ChatGPT question was parked as uncertain during a slow Thinkering restart

## What was seen

At 12:47 on 2026-10-16 Thinkering crashed twice and then started slowly, answering HTTP 503, while a ChatGPT turn for
session 6801 (turn 9114) was starting. Concierge retried the start for two minutes, then recorded the turn
`parked_ambiguous`, so it was never retried. Thinkering held no receipt for that run: nothing had been sent.

Related, not duplicated here: the 2026-10-09 records cover a start refused because Concierge itself was restarting
(`2026-10-09-chatgpt-start-failed-while-concierge-starting.md`, which added this two-minute retry) and an
already-sent answer lost to a bare 503 while being followed
(`2026-10-09-chatgpt-answer-failed-during-thinkering-start.md`).

## Cause

`startWhenOwnerAnswers` in `bot/src/session-capability-client.ts` retries a start while the error is restart-class
(`SESSION_OWNER_UNAVAILABLE`, `CAPABILITY_DISCONNECTED`, `CHATGPT_CAPABILITY_UNAVAILABLE` or a 503), backing off up to
20 s for at most two minutes. When the two minutes ran out it rethrew the last 503 itself. The owner classifies an
unrecognised start failure as an uncertain send, so the turn was parked as possibly sent and excluded from replay.
That was wrong: every attempt of a turn reuses one run id (turn 9114 made nine attempts under one id) and Thinkering
accepts a run at most once, returning an existing effect rather than sending again. A give-up after only restart-class
answers is a lost place in line, not an unknown effect.

## Fix

6fc0064c makes the give-up throw `CHATGPT_NOT_SENT` (not retryable inside the loop) instead of the raw 503. That code
is the existing no-budget retry path: the owner re-queues the turn under the same run id without spending the
per-turn retry budget. Non-restart errors are still thrown unchanged. `docs/architecture/SESSION-OWNER.md` records
the rule.

## Acceptance scenario

- **Seed:** An admitted ChatGPT turn with a fixed run id; a stand-in Thinkering capability endpoint that answers 503 to
  every start for three minutes, then accepts and records the run.
- **Action:** Concierge dispatches the turn.
- **Expected:** After two minutes the turn returns to its queue as not sent (not `parked_ambiguous`), is started
  again under the same run id once the endpoint accepts, and exactly one run exists on the stand-in.
- **Replayable offline:** yes (stand-in capability endpoint and clock; no real ChatGPT)
