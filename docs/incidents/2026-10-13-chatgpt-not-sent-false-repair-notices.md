---
failure: A Thinkering restart made eight waiting ChatGPT requests each file a false "ChatGPT channel" repair notice, though they were simply sent afterwards.
date: 2026-10-13
fix_commits: [6fa74ef6]
cause_status: confirmed
---

# A Thinkering restart woke the repair agent eight times for ChatGPT questions that were only waiting

## What was seen

A release restart of Thinkering at 22:02Z on 2026-10-13 left eight queued ChatGPT Pro requests settled as
`CHATGPT_NOT_SENT`. All eight were re-armed within 15 seconds and went on waiting for send pacing, but each
also filed a `chatgpt_channel` repair notice, so the repair agent was handed eight alarms about a channel that
was working.

## Cause

`noteChatgptChannelFailure` in `bot/src/session-execution-host.ts` files a repair notice for every ChatGPT
capability failure code except a short allow-list of self-resolving ones (`CHATGPT_RATE_LIMITED`,
`CAPABILITY_OWNER_LOST`, `CAPABILITY_OBSERVATION_ABORTED`, `CHATGPT_OBSERVATION_STOPPED`).
`CHATGPT_NOT_SENT` was not on that list. That code is written only for a run still `prepared` when
Thinkering restarts: nothing was typed into ChatGPT and the same run is re-armed by the existing retry path,
so it is a wait, not a channel fault. One restart with N queued sends produced N notices.

## Fix

6fa74ef6: `CHATGPT_NOT_SENT` joins the codes that do not notify. `CHATGPT_SEND_FAILED` still notifies,
because a repeated failure before dispatch is a real defect. The retry itself is unchanged.

## Acceptance scenario

- **Seed:** Eight queued ChatGPT turns whose runs are `prepared` (waiting for pacing) in a stub capability
  host; no open `chatgpt_channel` repair notice.
- **Action:** The stub host restarts and settles all eight runs with `CHATGPT_NOT_SENT`.
- **Expected:** All eight turns are re-armed and stay queued; zero `chatgpt_channel` repair notices are
  recorded. One `CHATGPT_SEND_FAILED` settlement in the same setup still records a notice.
- **Replayable offline:** yes (stub capability host and a scratch ledger; no real ChatGPT or Thinkering)
