# Proposal v1: threads with owners, an Inbox that keeps a directory, and a review that says when to add structure

Status: proposed to Tejas on 2026-09-25. Not approved, nothing built.

## The change in one sentence
Each thread gets one owning agent. Your replies go to that owner, and its answers appear in the thread in
its own words. The Inbox stops carrying conversations and instead keeps a directory of every thread (one
line each). It reads that directory to understand your new messages and hand them off well. A weekly
review, computed from the records, tells you when a part of the system is overloaded and a new layer
might be worth adding.

## Parts (all on the server unless noted)
1. Threads screen = home. Your threads replace the session sidebar. Each row shows its topic, its owner,
   the owner's one-line status, and whether it's waiting on you. Sessions that work on a thread are listed
   inside it. Agent-to-agent sessions stay hidden unless opened. The 202 Slack-era sessions that were never
   closed get marked done, not deleted.
2. Ownership. Handing a thread to a session makes that session its owner. A reply in the thread goes to
   the owner's queue, and the owner posts into the thread. The Inbox is not woken. On the Mac the same
   happens over the existing link between the two machines.
3. Hand-off packet. The Inbox cannot hand off without: your exact words, what it thinks you mean, related
   threads and sessions, and what done looks like. The system refuses a hand-off missing them. The owner's
   first post restates what it understood before any work.
4. Directory. Every owner keeps a one-line status on its thread. It's filled in when it declares an outcome,
   which already happens. The Inbox reads the directory fresh for each new message. Its knowledge lives in
   the records, not its memory, so it can start fresh each day and lose nothing.
5. Inbox job. It places new messages (new thread or existing), expands them, hands off with pointers, and
   moves a thread when you say it's in the wrong place. It never answers and never relays. It stays a
   full-context model. To pull it back into a thread, you use Move or mention it.
6. Operating review (the tracker). The review is computed by code from the records, never from an agent's
   memory. Per project it counts: open threads at once, threads that touch the same work, how often you
   moved a thread or corrected a read-back, how often you repeated yourself, how long owners took to
   answer, and how much of the Inbox's reading went beyond the directory. It comes weekly and on request.
   Each trigger is written down in advance, for example "project X had 10+ open threads and 3+ overlaps
   this week". When one fires, you get a proposal to add structure. You decide. It only adds structure;
   it never changes anything on its own.

## What it replaces
The Inbox relaying worker answers (59% of what it read), the Inbox posting on others' behalf, the flat
session sidebar, and the incident-by-incident rulebook (roles become structure).

## Grounding
Index, not content: hippocampal indexing and transactive memory. One owner, explicit hand-off, read-back:
hospital attending, I-PASS and air traffic control. Centre out of operations: M-form and the viable system
model. Add coordination only when direct contact fails: Galbraith and Mintzberg. Allocation adjusted from
cheap rates: ant interaction rates. A proposal you approve before structure changes: Engelbart and the
foundations rule.
