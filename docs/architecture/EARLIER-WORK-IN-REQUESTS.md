# What came before: earlier work in every work request

Current state as of 2026-11-04. Source: `bot/src/request-history.ts`, the `ask` and `reply`
paths in `bot/src/session-communication.ts`, and `answersQuestionsOnly` in `bot/src/session-owner.ts`.

## Why

Tejas's saving and sync failures went to about twenty separate sessions between September 16
and November 4, 2026. Each started from the one message it was handed; none looked up the
earlier requests, fixes or sessions, so failures came back and were "fixed" again. Tejas,
2026-11-04: "If there's a bug, if there's a regression, isn't your first job to see what was
done before? What came before you? Why do these agents have zero situational awareness?"
Looking back had been left to each agent; this makes it part of the request.

## What a work request carries

When an agent or the Inbox router sends a request with requested effect `work` (not ChatGPT,
not a consultation-only session, not saved or scheduled role work), the owner looks up, before
it records the request:

1. **Earlier requests in the same Inbox thread** (its topic root): recipient, what was asked,
   how it ended, the reply's own words and its checked/not-checked line. Exact, from the
   request ledger.
2. **Earlier sessions closest in meaning** to the request's summary and words, from the same
   session search agents use (meaning score at least 0.55, up to six), each with the latest
   request it was given and how that ended.
3. **Diagnosed failures** in thnkr.ing's failure ledger
   (`thinkering/docs/retrospectives/agent-failure-ledger.md`), compared by meaning through the
   owner's meaning index (cached per case), up to three.

Each earlier session states whether and how it can be asked now. The block is prepended to
the request's words under `WHAT CAME BEFORE`. The request's retained payload records the counts
(`history`). A first-time problem simply has no block.

**Speed.** The thread history is one indexed ledger read. Session search and the failure-ledger
comparison each get 2.5 s; whichever has not answered is named under "Not consulted" rather
than waited on. The lookup runs once, when the request is first accepted; an idempotent retry
returns the existing receipt. Each lookup logs `request_history_looked_up` with its time.
Peer (Mac) requests get the same block in their words; the peer's stored words are reused on
retry.

## The first reply states it

The first reply (partial or final) to a request whose payload recorded any earlier work must
carry `--before "<what that work did and how this approach differs>"`; the owner refuses it
otherwise, the same way completed work needs `--checked`. A hand-back is exempt. The statement
is folded into the reply's words as "What came before: …", so the requester, and Tejas in an
Inbox thread, read it. Peer-delivered requests are not gated on the replying machine.

## Every earlier session can answer a question

- **Handed off** (provider-change handoff accepted): an ask to the predecessor's address is
  forwarded to the successor, following the chain; the request records `forwardedFrom`.
- **Archived or paused** Claude or Codex session Concierge started: work asks are refused (its
  work stays as it was left); a question is answered synchronously by a side copy of its
  conversation, the same throwaway copy thnkr.ing's side questions use (no tools, never saved,
  the session is not woken). No request is opened; the answer is the command's result, and an
  answer that takes over 90 s is collected by repeating the same command and action ID.
- **Conversations from outside Concierge** (imported Claude/Codex transcripts): already
  answered questions through a consultation copy; their capability reason now says so instead
  of only "Archive evidence is read-only".

The capability `reason` of each such session says how it answers, so search no longer reads as
"cannot answer".
