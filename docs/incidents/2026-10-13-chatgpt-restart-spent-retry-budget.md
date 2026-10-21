---
failure: Agents' queued ChatGPT questions were given up as failed after several Thinkering restarts, although none had ever been sent.
date: 2026-10-13
fix_commits: [9e13a3a3]
cause_status: confirmed
---

# Queued ChatGPT questions were stopped after app restarts that never sent them

## What was seen

On 2026-10-13 eight agent ChatGPT Pro requests were re-armed together after a Thinkering restart and waited
for send pacing (at most 6 sends an hour, 2 minutes apart). Four more Thinkering restarts followed while they
waited. At 22:39Z turns 8115 and 8125 were stopped with their retry budget spent, and their requesters got
failures, although nothing had ever reached ChatGPT.

## Cause

Thinkering settles a ChatGPT run with `CHATGPT_NOT_SENT` only when it restarts while the send is still
`prepared`, waiting its pacing turn. Since ef57e633 that receipt was `retryable`, but `executeAgentTurn` in
`bot/src/turn-execution.ts` handled it like any other retryable provider failure: it recorded a transient
failure against the turn's per-turn retry breaker (5 attempts). Each Thinkering restart therefore counted as a
failed send, and a turn waiting through five restarts exhausted the budget and was parked as failed. A lost
queue place was being treated as a provider fault.

## Fix

9e13a3a3: a replay-safe ChatGPT failure carrying `CHATGPT_NOT_SENT` (`chatgptPlaceLost`) is retryable and
skips the retry-budget accounting, like sign-in and allowance waits. It cannot loop by itself, because each
occurrence needs a new Thinkering restart. `CHATGPT_SEND_FAILED` keeps the bounded budget, since a send that
keeps failing before dispatch is a real fault. AGENTS.md records the rule. This commit also re-queued the
turn for an immediate attempt, which caused the "claimed twice" regression
(`2026-10-13-chatgpt-turns-claimed-twice.md`); 8cbd6a13 restored the ordinary retry delay without changing
the budget rule.

## Acceptance scenario

- **Seed:** One queued ChatGPT turn whose run Thinkering settles as `prepared` with `CHATGPT_NOT_SENT`; the
  turn's retry breaker at zero attempts.
- **Action:** The capability host reports `CHATGPT_NOT_SENT` for that turn six times in a row (six simulated
  Thinkering restarts), then accepts the send.
- **Expected:** The turn stays queued after every occurrence, its retry breaker never records an attempt, and
  it is sent once on the seventh dispatch. Six `CHATGPT_SEND_FAILED` receipts instead exhaust the budget and
  park it.
- **Replayable offline:** yes (stub capability client returning the receipts; no real ChatGPT needed)
