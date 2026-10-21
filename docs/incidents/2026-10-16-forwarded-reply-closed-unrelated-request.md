---
failure: Answering a new question Tejas asked in a thread marked an earlier, unfinished lyrics build in the same thread as completed.
date: 2026-10-16
fix_commits: [a5a2417b]
cause_status: confirmed
---

# A Fully Kiosk answer closed an unfinished lyrics build

## What was seen

On 2026-10-16, in an Inbox thread where an agent had an open request to build a lyrics display, Tejas sent that agent a
separate question about Fully Kiosk. When the agent answered the Fully Kiosk question, the thread recorded the lyrics
build request as completed, although the build was unfinished (`docs/contracts/native-inbox.md`, the October 16 note).

## Cause

`linkForwardedReplies` in `bot/src/session-topics.ts` links a reply of his that is forwarded to a working agent to an
earlier topic request as one of its dispatches, so the answer to his reply can settle that request. It chose the
request by a fallback chain: the request whose posted answer he replied to; else the one open request that same agent
was working on in the thread; else (all closed) the newest one it had worked on. His Fully Kiosk question replied to
no lyrics answer, but the agent had exactly one open request in the thread, so the question was linked to the lyrics
request. The agent's "done" answer to the question was then the latest answer for that request, and the settle step
(`topic-settle:<request>:<work>`) closed it `completed`. Sharing an agent and a thread was treated as proof of shared
work.

## Fix

a5a2417b removes both fallbacks. A forwarded reply is linked to earlier work only when it replies to exactly one
request's posted answer (`byAnswer.length===1`); otherwise nothing is linked, and the new question is its own work. A
reply to an answer still settles or reopens that request as before. `docs/contracts/native-inbox.md` and `AGENTS.md`
were updated.

## Acceptance scenario

- **Seed:** An Inbox thread with one open topic request dispatched to agent A (the build), no answer posted yet.
- **Action:** Tejas sends a new message in the thread addressed to agent A, not replying to any answer; A answers it
  with a final `completed` reply.
- **Expected:** The answer is posted in the thread, the build request stays open, and its dispatches do not include the
  new message. A reply that does answer the build's posted answer is still linked to it.
- **Replayable offline:** yes (ledger topic and request rows plus scripted agent replies; no provider)
