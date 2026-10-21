---
failure: A thread showed three identical "Working on it now" cards for one session, as if one message had been sent three times.
date: 2026-10-07
fix_commits: [8ba9535d]
cause_status: confirmed
---

# Three identical "Sent to" cards made one thread look broken

## What was seen

Tejas, 2026-10-07, bug report on the thread page: "Why did I just see three different sends to the same session
here? Did you like literally send 3 different messages or like something is broken here?" Three separate
requests to one session (two already answered, one running) appeared as three identical cards, all "Working on it
now", stacked under his latest message.

## Cause

Confirmed from the commit. The dispatch attached to an Inbox topic request (`requestView` in
`bot/src/session-topics.ts`) was a snapshot taken when the request was linked ("admitted", no outcome) and never
updated. With no outcome on the dispatch the app fell back to the session's live state, so every card showed the
session as working, and with no source message or time the cards all sat under the newest message.

## Fix

8ba9535d: `requestView` projects each dispatch from the live request row: current outcome and status,
`sourceInputId` (the Inbox message the router was answering when it sent it), `at`, and the first 240 characters of
its words. A row the owner no longer has keeps the snapshot. Rehearsed on a copy of that thread: 47004c17 answered
20:52, df5cedd4 answered 21:01, 968bdc7b failed 21:50, f2022448 admitted 21:59, each under its own message.

## Acceptance scenario

- **Seed:** a topic with three requests to one session linked from three different Inbox messages: two settled
  (one completed, one failed), one running.
- **Action:** read the topic.
- **Expected:** three dispatches with distinct status/outcome, `sourceInputId`, time and words; only the running one
  reads as working; each sits under the message it answered.
- **Replayable offline:** yes (scratch ledger)
