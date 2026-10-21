---
failure: Agents' marked answers to Tejas's thread questions were refused, then re-sent as unmarked progress, so the question showed no answer.
date: 2026-10-21
fix_commits: [7c9e67df, b35fcf5f]
cause_status: confirmed
---

# Agents' answers to thread questions were refused or lost as ordinary progress

## What was seen

Over a week the reply command refused `--answers-question` 118 times, 112 of them on work the Inbox router
had dispatched into his threads. Workers re-sent the same words as unmarked progress, so his recorded
question showed no answer. One urgent recovery answer (request 39914136) read as unseen for hours. Related
but distinct from the 2026-10-21 interim-answer phone alert, which is about notification, not acceptance.

## Cause

`reply` in `bot/src/session-communication.ts` accepted the answer mark only when the request carried a
forwarded human reply (`promptAnswer`). Work the router dispatched after recording his question in the
thread never had that, though its replies post into the same thread, so the owner threw "`--answers-question`
needs an answer in a partial reply to a human thread question". Second effect (b35fcf5f): the Mac keeps
its own mark while the origin drops it where no thread applies, so the origin rejected every bodyless final
that followed ("needs an earlier prompt answer"), losing the Mac agent's closing answer.

## Fix

- 7c9e67df: the mark is accepted on any request whose replies post into an Inbox thread (`answerThread`
  split out of `threadAnswer`), local and Mac. Where it cannot apply (a final, empty text, no thread) the
  CLI and owner drop it, record the reply as written and return the reason as a receipt `notice`, instead
  of refusing. `docs/architecture/PROMPT-THREAD-ANSWERS.md` updated.
- b35fcf5f: `SessionPeers` records `answerMarkDropped` on the progress event when it drops the mark, and a
  later bodyless final accepts either marker and uses that answer's text as its body.

## Acceptance scenario

- **Seed:** An Inbox thread with his recorded question; a router-dispatched work request naming that
  thread (local), and a second such request on a Mac peer; a third request with no thread.
- **Action:** The worker sends a partial reply with `--answers-question`, then a bodyless final.
- **Expected:** The thread/local and Mac replies post marked as the answer to his question and the question
  shows it; the no-thread request records the reply as ordinary progress with a `notice` explaining the
  dropped mark; the bodyless final is accepted and the requester reads the answer's words. Nothing is refused.
- **Replayable offline:** yes for the local path and the origin's peer handling (stub peer); no for a real Mac end to end
