---
failure: Tejas asked to be notified when work was done and got a phone push repeating his own words after an unrelated agent run finished, with no agent answer behind it.
date: 2026-10-14
fix_commits: [4dd8e99c]
cause_status: confirmed
---

# A requested phone notification fired on an unrelated run and showed his own words

## What was seen

On the evening of 2026-10-14 Tejas got a push for a thread where he had asked to be notified. The
push was a service sentence built from his own request, not the agent's answer, and no answer had
been posted. His words (~7 PM ET): "why am I being notified of my words instead of the agents'
response in the thread? Scrap all the nonsense you guys recently built to 'enforce' notifications."

## Cause

The notify-when promises (5a2e3c65, live from 16:02 ET that day; `bot/src/notify-when.ts`) let the
router point a marked input's promise at a session with `sessions notify-when --session ...
--summary "<quote of his words>"`. A watcher then fired on that session's next run:
`reconcileLocalNotificationPromises` (and the Mac peer event replay) called `finish()` with
`${label} finished.`, where `label` was his quoted summary, and emitted a `needs_you` event that
thnkr.ing pushed. The watcher checked only "the next run in that session ended", not whether the run
answered his request. Here the promise for capture `142e3971…` was pointed at `mac:75`; when mac:75
finished an unrelated turn at 22:56 UTC, `finish()` posted a Service entry and pushed his own words.

## Fix

4dd8e99c removes the promise machinery: `notify-when.ts` (the watcher, pointing, quote rule, peer
replay, expiry, backfill and every service post it wrote) and the turn-outcome refusal of an
unarranged promise. A message his words mark `result` now arms its Inbox topic
(`bot/src/thread-notifications.ts`). The first agent message in that topic consumes the arm in the
same transaction and emits one notification whose `postId` names that message and whose body is
that message's words. A push cannot exist without an agent message behind it. An agent can request
one push for its own message with `sessions post --notify` or `sessions reply --notify`, which shares
the same one-push dedupe. A router acknowledgement while dispatched work is still out does not
consume the arm. Old promise rows stay inert. `docs/contracts/requested-phone-notifications.md` and
`AGENTS.md` were rewritten.

Context: 18cb3c86 (a router acknowledgement settling the promise before the dispatched answer)
fixed a defect a reviewer found in 5a2e3c65. Nothing shows it was seen live, so it is not listed.
A later, different failure (an interim answer consuming the arm) is
[2026-10-21-interim-answer-phone-alert.md](2026-10-21-interim-answer-phone-alert.md).

## Acceptance scenario

- **Seed:** An Inbox topic with a human message "notify me when this is done", work dispatched to
  a worker session that also has an unrelated queued turn.
- **Action:** The worker's unrelated turn finishes; later the worker posts its answer in the topic.
- **Expected:** No push when the unrelated turn ends. Exactly one requested notification when the
  answer is posted, naming that post and carrying its words. No push text contains his request.
- **Replayable offline:** yes (scratch ledger and owner; stub provider turns; check the emitted
  `needs_you` events instead of a real phone)
