---
failure: Threads Tejas had just spoken into fell off the first page of his Inbox, and agents' requests to the router sat in his Inbox as "Being sorted" forever.
date: 2026-10-08
fix_commits: [3aecf83e]
cause_status: confirmed
---

# Threads looked missing and agent requests waited to be filed in his Inbox

## What was seen

Tejas, report 9725b150 on 2026-10-08: "A lot of items ... are missing ... The order seems to be not correct."
Threads he had just spoken into were not on the first page. Separately, raw "Session request ... agent-authored
input" rows sat in his Inbox marked Being sorted and never left.

## Cause

Confirmed from 3aecf83e.
- Ordering: open threads were ranked in bands (`listTopics` in `session-topics.ts`, mirrored in
  `prepared-topic-values.ts`): anything with a decision or something to read first, then work moving, then
  unread, then the rest. Nearly every thread carries something to read, so the first band filled the first
  page and recently active threads in lower bands fell past it.
- Sorting pile: the unfiled-roots count included every root without a topic, including agents' requests to the
  router, which are request/reply coordination and never get filed as his topics.

## Fix

3aecf83e: open threads are one list ordered by the conversation's own time (band always 0); needs-you keeps its
own filter and count. Only inputs he sent himself (origin `human`, no `session_input_author_corrections` row,
`isHisOwnRoot`) can wait to be filed, in both the live and prepared readers (`prepared-topics.ts` gains
`own_items_only`). The prepared topic projection rebuilds once to take both rules. (That rebuild caused the
[empty thread list](2026-10-08-thread-list-empty-during-rebuild.md), fixed separately.)

## Acceptance scenario

- **Seed:** 30 open threads all carrying a reading item, one of which received his message a minute ago; one
  unplaced agent-authored request to the router and one unplaced human capture.
- **Action:** read the open thread list (first page of 20) and the unfiled list.
- **Expected:** the just-spoken thread is first; the unfiled list contains only the human capture.
- **Replayable offline:** yes (scratch ledger and presentation database)
