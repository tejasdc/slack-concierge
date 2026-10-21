---
failure: An agent's ChatGPT question that was already in progress was stopped for good because Concierge and Thinkering restarted at the same moment.
date: 2026-10-16
fix_commits: [cc747b87]
cause_status: confirmed
---

# A live ChatGPT run was parked when both services restarted together

## What was seen

At 00:52 on 2026-10-16 a Concierge update and a Thinkering release restarted within the same seconds. When the new
Concierge took back a live ChatGPT run, its one read of the run's receipt failed with `CAPABILITY_DISCONNECTED`
(Thinkering's socket was down) and the turn was parked permanently, so the agent's question never got its answer.

This is the third restart window for the same ChatGPT path and is distinct from the earlier two:
`2026-10-09-chatgpt-start-failed-while-concierge-starting.md` (a new start refused while Concierge restarted) and
`2026-10-09-chatgpt-answer-failed-during-thinkering-start.md` (an ongoing follow ended by a bare 503 while Thinkering
restarted). Both of those fixed the start and observe calls; neither covered the receipt read at adoption.

## Cause

In `bot/src/session-capability-client.ts`, a run taken back after Concierge's own restart (`context.follow`) first calls
`reconcile(run)` to read Thinkering's receipt for that run id, then follows it. Starting
(`startWhenOwnerAnswers`) and observing (`observeAcrossRestart`) already waited out a Thinkering restart, but this
receipt read was a single call. With Thinkering restarting at the same moment, the call failed with a restart-class
error, which propagated as a terminal failure of the adopted run.

## Fix

cc747b87 generalises `observeAcrossRestart` into `readAcrossRestart`, a read-only loop that waits out
`CAPABILITY_DISCONNECTED`, `CHATGPT_CAPABILITY_UNAVAILABLE` and 503 for up to 20 minutes (backoff 2–30 s), and wraps the
adoption-time `reconcile` in it. `CHATGPT_EFFECT_NOT_FOUND` still leads to the single permitted send; any other answer is
the run's own state. The loop only reads, so it can never repeat a send.

## Acceptance scenario

- **Seed:** A ChatGPT run acknowledged by a stand-in Thinkering capability host and recorded in the ledger as live; the
  stand-in's socket is closed (refusing connections) for 60 seconds, then answers 503 for 20 seconds, then serves the
  receipt.
- **Action:** Restart Concierge (or run the owner's startup adoption) inside that window.
- **Expected:** The adopted run keeps waiting, then reads the receipt and follows the run to its answer; it is not
  parked, and no second send reaches the stand-in.
- **Replayable offline:** yes (stand-in capability socket; no real ChatGPT or Thinkering)
