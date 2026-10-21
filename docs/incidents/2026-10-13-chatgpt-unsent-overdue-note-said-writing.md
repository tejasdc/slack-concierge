---
failure: An agent waiting on a ChatGPT question was told ChatGPT was writing its answer when the question had not been sent yet.
date: 2026-10-13
fix_commits: [adb4e5df]
cause_status: confirmed
---

# The 15-minute note said ChatGPT was writing an answer to a question it had never received

## What was seen

On 2026-10-13 session 6065, which had asked ChatGPT a question, received the 15-minute overdue note "ChatGPT is
still writing its answer to … Pro answers can take an hour." Nothing had been sent: the request was still
waiting behind send pacing in Thinkering. The agent was given a false picture of where its question was.

## Cause

The overdue check for ChatGPT requests in `bot/src/session-communication.ts` treated any healthy turn
(running under a live owner, not stopping) past `STILL_WAITING_MINUTES` as being answered, and always wrote the
"still writing" text. It never read whether ChatGPT had acknowledged the input
(`turns.provider_input_acknowledged_at`), so a send waiting its pacing turn (at most 6 sends an hour, 2 minutes
apart) looked the same as one ChatGPT was working on.

## Fix

adb4e5df: the overdue query also reads `provider_input_acknowledged_at`. Acknowledged keeps the "still
writing" note; unacknowledged says the question has not been sent yet and is waiting its turn at up to 6 sends
an hour, 2 minutes apart, and that it will go out and answer by itself. Concierge does not hold Thinkering's
queue position, so the note states the pacing rather than a place in line. The event's health text changes the
same way ("waiting its turn to be sent to ChatGPT").

## Acceptance scenario

- **Seed:** A ChatGPT agent request bound to a running turn under a live owner, with
  `provider_input_acknowledged_at` null and the request created 16 minutes ago; a second identical request
  whose turn is acknowledged.
- **Action:** Run the request liveness check.
- **Expected:** The unacknowledged request's overdue event says it has not been sent to ChatGPT yet and is
  waiting its turn; the acknowledged one says ChatGPT is still writing. Each gets exactly one overdue event.
- **Replayable offline:** yes (scratch ledger rows and a fixed clock)
