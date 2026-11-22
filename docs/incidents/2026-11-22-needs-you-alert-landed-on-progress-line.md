---
failure: A Needs you phone alert from a directly messaged session opened and marked an earlier progress line instead of the question it was about.
date: 2026-11-22
fix_commits: []
cause_status: confirmed
---

# Needs you alert highlighted a progress line

## What was seen

Bug report capture `767dc2607f8ef5c3dd2be692e5b9983e7147ed16bbe0e66eb0d8d902336c106f` (report
5df64e78, Nov 22, 5:02 PM Eastern). Tejas tapped a phone alert from the Blygger hackathon session
(concierge:3957). It opened that session with the 4:52 PM progress line ("The memory refresh is
back. Now setting up Discord sign-in…") outlined and "Notified Mac app, Linux app and iPhone app"
under it, so he read it as a progress note that had notified him. His words: "Wait, I don't really
understand why I was like notified for this particular message. And why am I inside my session?
Shouldn't it navigate to my actual thread here?"

The only alert sent was the genuine 4:56:29 PM Needs you asking him to scan Discord's sign-in QR
code (notification history 3680). The progress line sent nothing.

## Cause

The question came from Tejas's direct message to that session (input 81050030), which had no Inbox
thread binding, so its attention event named no post. thnkr.ing therefore addressed the alert as
"the latest answer to that input as of 4:56:29". The agent declares its outcome before the provider
writes its closing prose; that prose appeared at 4:56:48, 19 seconds later. At 4:56:29 the latest
answer was the 4:52 progress line, so the tap landed there and the delivery receipt, placed by the
same rule, sat under it. A separate Blygger Inbox topic exists, but nothing linked this direct
message to it, and a title match is not authority to guess one.

## Fix

Concierge's needs-you attention event now names the open question it raised (`needEventId`, the
same identity the session's "Needs attention in this session" list uses). thnkr.ing addresses the
alert to that question in the session, lands on and marks it, and files the delivery receipt
against it, so no conversation message receives another message's badge. Inbox-bound work keeps
opening its exact thread at the question; a direct message with a retained thread binding keeps
that existing route. Older alerts keep their stored links and receipts.

## Acceptance scenario

- **Seed:** A marked non-Inbox session whose direct human input makes the agent write a progress
  line, then declare needs_you, then write its closing prose several seconds later.
- **Action:** Tap the resulting alert before and after the closing prose exists.
- **Expected:** Both taps land on the open question in that session, not the progress line; the
  "Notified …" receipt sits with the question; the progress line has no receipt.
- **Replayable offline:** no (needs the installed owner, thnkr.ing courier and a browser landing).
