---
failure: A request held by ChatGPT Pro's usage limit showed only "admitted, queued" to its requester, while the reason and reset time existed only in the owner journal.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# A held request showed "queued" with no reason

## What was seen

At 7:42 PM Eastern on 2026-11-17 an agent's ChatGPT Pro review request (turn 33177, session
10064) read as `admitted, queued` through `sessions get`, with no acknowledgement, result or
reason. The owner journal said every minute that ChatGPT Pro's usage limit was reached,
nothing was sent, and it resets at 1:01 AM Eastern (`provider_turn_retry_queued`,
`failure_class:"backoff"`, 15 times in the hour). The requester learned this only by reading the
privileged journal.

The same evening a Codex request (5148ce94, asked 7:11 PM) to an idle Codex session sat queued
until 8:06 PM with nothing shown, while that Codex account had room. That session's previous
turn had ended at 7:04 PM and no retry was recorded for it. Four Codex sessions started in the
same second at 8:06 PM, just after a runner machine call finished. That timing matches a
Codex-wide admission hold (account switch, Codex update or App Server repair), which keeps new
Codex work queued until running Codex work ends. The ledger was not readable from the
investigating sandbox, so which holder it was is the best explanation, not confirmed.

## Cause

1. The request receipt (`session-communication.ts` `receipt`) carried only the turn's raw
   status. The owner already computes a plain-words hold explanation for inputs
   (`receiptStatusFromFacts`), but no request read included it.
2. Thinkering returns a Pro limit as proven-unsent `CHATGPT_NOT_SENT` whose message names the
   reset. `ChatGptDispatchError` passed no `clearsAtMs`, so the owner treated it as an ordinary
   never-sent retry: it re-ran the browser roughly every minute until the reset. The input
   status would have read "ChatGPT is not answering right now".
3. Codex-wide admission holds (`codex-admission-holds.ts`) were not among the status reasons, so a
   Codex request held behind one read as plain queue, and the thread standing as "No word yet".

## Fix

- `sessions get` and request inspection of an open request carry `hold` (the target input's
  live status detail) and `standing` (the thread view's standing line).
- A proven-unsent `CHATGPT_PRO_LIMIT_REACHED` carries its reset as `clearsAtMs`, so the turn is
  held as a usage wait until then (`PROVIDER_USAGE_HELD`, ChatGPT's reset as `clearsAt`). The
  requester gets the existing immediate held notice. Other unsent ChatGPT refusals show
  ChatGPT's own reason.
- A Codex-wide admission hold is `PROVIDER_ADMISSION_HELD` with words naming the switch, update
  or repair, and the request standing reads "Waiting for Codex to finish …".

## Acceptance scenario

- **Seed:** an open agent request whose target ChatGPT turn is queued after a
  `CHATGPT_NOT_SENT` failure with message `CHATGPT_PRO_LIMIT_REACHED: nothing was sent; … (ChatGPT
  Pro usage limit reached; resets <future time>).`
- **Action:** the requester runs `sessions get <request-id>`.
- **Expected:** `hold.code` is `PROVIDER_USAGE_HELD`, `hold.clearsAt` is the reported reset, the
  message says nothing was sent and when it goes again, and the turn's next attempt is at that
  reset rather than about a minute later.
- **Replayable offline:** yes (seed the turn row and request; `receiptStatusFromFacts` and
  `chatGptLimitResetMs` are pure).
