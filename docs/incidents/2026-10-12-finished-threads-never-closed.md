---
failure: Inbox threads whose work had finished stayed open indefinitely (71 at once), because finished requests were never settled and no thread ever closed itself.
date: 2026-10-12
fix_commits: [2840755c, 8818c2f6, f747cede, 56518b98]
cause_status: confirmed
---

# Seventy-one finished threads stayed open

## What was seen

Capture d30a141a: Tejas's Inbox had 71 open threads whose work had finished. Requests stayed open forever and the list
never cleared itself.

## Cause

Per the commit: his replies to the agent working a request were never linked as that request's work, so the request did
not see its work end; a failed answer posted into the thread closed nothing; and no rule closed a thread when the last
thing in it ended (`bot/src/session-topics.ts`).

## Fix

2840755c links forwarded replies to the request whose agent received them, settles an open request when all its work
ended (done → completed under `refuseUnfinishedCompletion`, failed → failed, cancelled → withdrawn, others flagged once to
the router), closes a thread when its last request or question ends and nothing is open, waiting on him or running, and
reopens it when he writes there or new work lands. 8818c2f6, f747cede and 56518b98 are review fixes on the same pull
request: set-aside questions count as waiting, a reply reopens only the newest request, every topic change runs the rule,
and one answer is judged once so the thread does not flicker.

## Acceptance scenario

- **Seed:** A thread with one request whose agent answered done and one deferred question; another thread whose only
  request's agent failed.
- **Action:** Settle the deferred question; then Tejas writes in the closed second thread.
- **Expected:** The first thread closes once the question ends; the second thread is closed with its request failed, and
  reopens when he writes.
- **Replayable offline:** yes (scratch ledger)
