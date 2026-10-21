---
failure: A Concierge cancellation notice, with request and session numbers, was typed into one of Tejas's ChatGPT chats.
date: 2026-10-09
fix_commits: [e7d90976, 93beab80]
cause_status: confirmed
---

# A Concierge notice appeared inside a ChatGPT chat

## What was seen

Tejas found a cancellation notice reading like "Request 7c247e23-… from concierge:4622 was canceled by its requester …
This is a system notice, not new authorization" inside a ChatGPT chat. ChatGPT sessions are driven by typing the input
into his real ChatGPT browser session, so any service input to such a session became a ChatGPT message.

## Cause

ChatGPT sessions accepted service-origin inputs (cancellations, returns, reminders) like any other provider session, and
request cancellation delivered its notice to the ChatGPT worker. The sender in `bot/src/session-execution-host.ts` did not
distinguish origin, so the notice was sent to ChatGPT verbatim. The notice text itself was written for machines.

## Fix

e7d90976 makes the ChatGPT sender refuse `origin: service` inputs and makes cancellation skip ChatGPT workers, so only
people's and asking agents' words reach ChatGPT. It also adds `--his-chat` so chats Tejas asks for himself are marked
apart. 93beab80 (same evening) rewrites agent-facing notices in plain words without request or session numbers, so any
notice that does reach a conversation is readable.

## Acceptance scenario

- **Seed:** A ChatGPT session with an open agent request; a stub ChatGPT capability that records every text it is asked
  to send.
- **Action:** The requester cancels the request (and, separately, a return is addressed to the ChatGPT session).
- **Expected:** The stub records no send for the cancellation or return; the request settles as cancelled in the ledger.
- **Replayable offline:** yes (stub capability host)
