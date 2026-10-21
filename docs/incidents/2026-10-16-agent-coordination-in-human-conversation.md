---
failure: Agents' bookkeeping requests to the Inbox, full of raw IDs, and the Inbox's replies to them appeared as messages in Tejas's lyrics work thread.
date: 2026-10-16
fix_commits: [bd1e699b]
cause_status: confirmed
---

# Agent-to-Inbox bookkeeping requests showed up in his work thread

## What was seen

At 2:37 AM ET on 2026-10-16, on thnkr.ing on his iPhone, Tejas found five "Request from Synced lyrics…" cards in his
"Lyrics of what's playing" thread, full of topic, message and request IDs, with the Inbox router's replies beneath
them. His words: "I don't understand what this request is, or who it is for … Why are there so many nonsensical topic
IDs? … And I also see a response from you, the Inbox agent, in here. Why did you even respond?"

## Cause

The tablet worker (session 6739) had been refused when recording his questions ("The source must be Tejas's message in
this thread", a separate defect), so it sent the Inbox router agent requests asking it to record them. Two owner
behaviours then put that coordination in front of him:
- `topicPromptContext` in `bot/src/session-topics.ts` gave every unplaced Inbox input a `<topic-placement>` block
  instructing the router to file it in a topic before routing, agent requests included. The router dutifully placed
  them in his lyrics thread.
- The Inbox conversation readers (`inboxRowsWhere` in `bot/src/session-inbox.ts` and the prepared-message source in
  `bot/src/presentation-message-source.ts`) showed every Inbox `accepted` input and turn `result` regardless of origin,
  so a placed agent request rendered as a request card and the router's required reply as a message.
Confirmed by the router's own records in the request that produced the fix.

## Fix

bd1e699b treats an Inbox input with `origin='agent'` and a `request_id` as request/reply coordination, not a
conversation root:
- `topicPromptContext` returns no placement block for it, so the router is not told to file it.
- Both the live Inbox rows and the prepared message source omit its accepted input and turn result; deliberate agent
  posts (`sessions post`) stay visible, and the request and reply remain in the agents' session receipts.
- The presentation worker records `agent_request_visibility_version` and rebuilds once, so cards already in his
  threads disappear without deleting records.
`docs/contracts/native-inbox.md` and `AGENTS.md` state the rule. The raw-ID formatting he also asked about was not
part of this commit.

## Acceptance scenario

- **Seed:** An Inbox session with an open topic; a worker session that sends the Inbox router an agent work request
  (no thread named) through `sessions ask`.
- **Action:** The router runs that request and replies to it.
- **Expected:** The router's prompt has no `<topic-placement>` block; neither the request nor the reply appears in any
  topic's Conversation or prepared page; the requester receives the reply in its receipts. An explicit agent
  `sessions post --thread` in the same topic is still shown.
- **Replayable offline:** yes (ledger rows and the presentation worker on a scratch state directory; scripted router)
