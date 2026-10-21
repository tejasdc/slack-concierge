---
failure: A question to ChatGPT sent while Concierge was restarting was marked permanently failed before anything was sent.
date: 2026-10-09
fix_commits: [55c732f5]
cause_status: confirmed
---

# A ChatGPT question failed because Concierge was still starting

## What was seen

The repair agent reported that the ChatGPT turn at 7:26 PM on October 9 (turn 6006) was marked permanently failed. The
question had been asked just as Concierge was restarting after an update, and nothing had been sent to ChatGPT.

## Cause

Thinkering verifies every ChatGPT start against the owner's operation record, by calling Concierge's request API. While
Concierge restarts that API is not listening, so Thinkering refuses with `SESSION_OWNER_UNAVAILABLE` before sending
anything. The capability client's `start` call propagated that refusal as a terminal error, so the run was recorded as a
permanent failure although the refusal meant only "ask again in a moment". The commit message and the repair report agree on
this; the sequence was not replayed separately.

## Fix

55c732f5 adds `startWhenOwnerAnswers` in `bot/src/session-capability-client.ts`. It retries `start` when the error is
`SESSION_OWNER_UNAVAILABLE` and the call was not aborted, backing off from 2 s up to 20 s, for at most two minutes, then
rethrows. Because the run id is the same on every attempt, a repeated start is idempotent on Thinkering's side (at most one
run per id), so no duplicate question can be sent.

## Acceptance scenario

- **Seed:** A ChatGPT request admitted for a session; a stand-in Thinkering that answers `SESSION_OWNER_UNAVAILABLE` to the
  first several start calls (owner API "not listening"), then accepts.
- **Action:** Concierge dispatches the ChatGPT start during that window.
- **Expected:** The turn does not fail; the start succeeds on a later attempt with the same run id and exactly one run exists.
  If the owner stays unavailable for over two minutes, the original error surfaces unchanged.
- **Replayable offline:** yes (stand-in capability endpoint; no real ChatGPT or restart needed)
