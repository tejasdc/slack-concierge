---
failure: His thread reply to a working agent sat Queued for 87 minutes, labelled Unknown agent, because a restart dropped its live hand-off and nothing let it join the running turn again.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# His reply sat "Queued" for 87 minutes behind a 2h20m turn, as "Unknown agent · Request"

## What was seen

Bug report, Nov 2 12:45 AM ET: "Why has this request shown up queued for more than an hour here?"
In "Canvas voice assistant bug fixes" (concierge:7325) his 11:19 PM ET reply in the Canvas voice
thread sat at the bottom marked Queued and labelled "Unknown agent · Request", while the session
showed one working turn of 2h 20m and other messages kept arriving and being answered.

## Cause

Confirmed from the ledger snapshot and run journals.

1. 04:19:20 UTC: the Inbox forwarded his thread reply to the working agent as request
   `e046f92d`. Concierge had restarted for an update at 04:17 and was re-attaching that run; the
   message entered the run's own hand-off queue (steering row 5859, turn 13978) while the run was
   not yet taking messages.
2. The 04:24 update restart discarded that hand-off queue. The row was marked `failed` with no send
   time ("Concierge restarted before this message was sent to the agent; it was never delivered.")
   and the input returned to the session queue as its own turn (14055).
3. The same live turn 13978 then took 16 more hand-offs (first at 04:35, last at 05:39). Every
   path that could fold a waiting message into a live run refused this one because it already had a
   hand-off row: the hand-off step (`deliver` in the execution host), `attachSessionSteering`, and
   `releaseEarlierWaitingInputs`. A row that is failed and never sent is the owner's own proof the
   provider never received it, but it was treated as a permanent barrier.
4. Turn 14055 started at 05:46:51 when the long turn ended.

Separately, the owner recorded the forwarded reply's author as an agent request with no sending
session, which the app renders as "Unknown agent".

## Fix

- One rule for whether an earlier hand-off blocks another: only one that may have reached the
  provider (sent, being sent, or uncertain). A failed, never-sent attempt does not. Used by the
  hand-off step, attaching a hand-off and releasing earlier waiting messages; recovery reads the
  latest attempt.
- A run taken back after a restart pulls its session's waiting messages in as soon as it takes
  messages again (not for the Inbox router, whose queue has its own rules).
- A forwarded thread reply whose source is his own message is shown as his ("You · reply in a thread").

## Acceptance scenario

- **Seed:** a Claude session in a long running turn; a message to it is in the run's hand-off queue
  when Concierge restarts, so its hand-off is recorded failed and never sent and it is re-queued.
- **Action:** the run is taken back and becomes ready; or any later message is handed to the run.
- **Expected:** the waiting message joins the running turn within seconds and is acknowledged by the
  provider; its byline names him when it is his forwarded thread reply.
- **Replayable offline:** no (needs a live Claude run and an owner restart).
