---
failure: When Tejas pressed Stop on an agent himself, the Inbox treated the cancelled run as news and notified him about his own action.
date: 2026-10-08
fix_commits: [82c86d09]
cause_status: confirmed
---

# His own Stop came back to him as a notification

## What was seen

At 7:16 PM EDT on 2026-10-08 Tejas stopped a Cortex run (concierge:4081, turn 5709). The request that run served
returned "The recipient execution ended with cancelled.", and the Inbox router treated it as news and notified
him about the stop he had just made.

## Cause

Confirmed from 82c86d09. Stop is retained as a human `stop` operation naming the exact run, but nothing read it
when the served request was closed. `session-communication.ts` settled every cancelled run's request the same
way, so the requester (here the Inbox router) could not tell his deliberate Stop from an unexplained
cancellation needing follow-up. The Mac's execution status carried no stop author either.

## Fix

82c86d09: new `stopped-by-tejas.ts`; a cancelled run's request settles with `output.stoppedBy: 'tejas'` (and the
time) when his stop operation names that run, else `'not-tejas'`, with plain words for each. The
refusal-continuation chain is followed to the run that actually ended. His stop of work the Inbox sent for a
thread is posted in that thread as a quiet service line; the router is not woken and nothing is filed for him.
The Mac reports `stoppedByTejasAtMs` and the server settles and posts the same way (`session-peers.ts`).

## Acceptance scenario

- **Seed:** an Inbox thread request dispatched to session S with a running turn; a second request to S2.
- **Action:** Tejas stops S's run through the human stop route; S2's run is cancelled by something else.
- **Expected:** S's request settles with `stoppedBy:'tejas'`, a quiet service line appears in the thread, no
  router turn and no notification; S2's request says it was not stopped by him and asks for follow-up.
- **Replayable offline:** yes for the server path (scratch ledger, stub provider); the Mac path needs a peer
