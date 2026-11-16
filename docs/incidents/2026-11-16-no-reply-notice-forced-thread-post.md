---
failure: Concierge forced the Inbox router to post into a work thread when closing a notice that required no reply.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# A no-reply reminder required a thread post

## What was seen

At about 06:30 UTC the Inbox router received an overdue service return about the Mac
Caps Lock agent. The notice said no answer had arrived within three minutes and
“You do not need to reply to this.” Declaring done was refused until it posted an answer
into the work thread; ending the turn instead would relay its closing text there.
The same gate had earlier caused an unwanted handoff/reminder post. Tejas asked:
“why the fuck are you responding here?”

Exact incident source: capture:4e58773e073e4514b54391c634c314d45e1ea0ebe66cc0d68e7c1fa0df4e74ee.
Retained notice: return:8f31f81a-4e97-4209-92a7-63b9e3da4796.
Its source run: cf771b5c-af3f-4cb8-a2c0-e7c31941c2f0.

## Cause

The thread answer guard correctly protected agent questions and real answers but also
classified owner-generated no-reply service notices as answers owed to that thread.
Some maintenance producers already set a trusted no-reply mark; the overdue-return
producer did not. The automatic relay shared that guard, so avoiding the explicit
outcome refusal did not avoid a post.

## Fix

Dedicated no-reply producers set the existing trusted service mark. Already-retained
notices are recognized by owner identity and exact local/peer overdue event records,
including an original notice carried through a handoff. Both outcome and relay consume
the same classification. No decision is inferred from message text; genuine worker
answers and agent questions retain the thread-post requirement.

## Acceptance scenario

- **Seed:** An Inbox work thread with a human request, a retained owner overdue reminder
  (local or peer), a no-reply handoff/maintenance notice, and an ordinary worker answer.
- **Action:** Handle the notice and declare done without posting; also exercise completion
  with closing text and no explicit post. Try the same quiet close for a worker answer
  and agent question, and try unexplained silence for the human message.
- **Expected:** Notice closure succeeds and creates no post or relay. The underlying work
  remains open. Real answers/questions still require a post and still relay when omitted;
  the human message still requires an explicit reason for silence.
- **Replayable offline:** yes (`bun bot/scripts/inbox-quiet-service-notices-fixture.ts`).

The fixture proves the disposable owner ledger's outcome and relay boundaries. Installing
the repair and observing the original Inbox close remain separate release acceptance.
