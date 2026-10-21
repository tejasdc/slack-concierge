---
failure: Moving a conversation root to another topic hid Tejas's accepted lyrics replies and their requested notifications.
date: 2026-10-16
fix_commits: [fef2edeb]
cause_status: confirmed
---

# Moving a topic root hid accepted lyrics replies and their notices

## What was seen

A bookkeeping move of a conversation root into a different topic made accepted replies in a lyrics thread
disappear, along with the notifications that had been requested for them. Fresh thread replies were also
unavailable for hours that day while the prepared index caught up.

## Cause

A human reply forwarded to an agent is bound to the topic it was sent from (`forwardedReply.topicId` on the
request, `thread_root_input_id` the root). `placeChange` in `bot/src/session-topics.ts` moved a root to a new
topic without checking that, so the agent's later answers and requested notices, which resolve through the
bound topic, were silently relocated away from where he was reading. Separately, the prepared message
generation still carried agent coordination rows (`request:%` inputs with `accepted`/`result` events) from
the older visible-message rule, and the only way to remove them was a full rebuild; the catalogue doc records
that a full rebuild left fresh thread replies unavailable for hours on 2026-10-16.

## Fix

fef2edeb:
- `placeChange` refuses (409 `FORWARDED_REPLY_TOPIC_MOVE`) moving a root that has a forwarded human reply
  bound to its current topic, telling the caller to route the exact human message instead.
- `upgradeAgentRequestVisibility` in `presentation-message-worker.ts` deletes only those obsolete agent
  request rows from the active generation in batches of 50, advances from its watermark, and sets
  `agent_request_visibility_version=1`, instead of triggering a full rebuild.
- Documented in `AGENTS.md`, `docs/contracts/native-inbox.md` and `docs/architecture/PREPARED-SESSION-CATALOGUE.md`.

## Acceptance scenario

- **Seed:** A topic with a root whose human reply was forwarded to an agent (request with `forwardedReply.topicId`
  set); a second topic; a prepared generation holding obsolete `request:%` rows.
- **Action:** Ask to place that root into the second topic; separately start the message worker.
- **Expected:** The placement is refused with `FORWARDED_REPLY_TOPIC_MOVE`; the reply, the agent's answers and
  the requested notice stay in the original topic. The worker removes only the obsolete rows in bounded
  batches without a rebuild and thread replies stay readable throughout.
- **Replayable offline:** yes (ledger fixtures and prepared store)
