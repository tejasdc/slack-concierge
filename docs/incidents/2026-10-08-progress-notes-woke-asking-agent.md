---
failure: Every "still working" note from one agent woke the agent that asked, which re-read its whole conversation each time.
date: 2026-10-08
fix_commits: [cf0b5d4d]
cause_status: confirmed
---

# Progress notes woke the asking agent and burned its allowance

## What was seen

Measured on concierge:4168 on 2026-10-08: each progress return re-read its ~860k-token conversation, and one
note sent to four of its requests woke it four times. Allowance was spent re-reading context that the note
did not need.

## Cause

Confirmed from cf0b5d4d. A partial reply (`sessions reply --partial`) was admitted as a `return:<eventId>`
input to the requester, locally in `deliver()` (`session-communication.ts`) and from a peer
(`session-peers.ts`), exactly like a final. Each admitted return starts or joins a requester turn, and a
Claude turn re-sends the whole conversation. Only the Inbox already treated partials as non-waking.

## Fix

cf0b5d4d: a `progress` event is marked `received` and not admitted as an input, on this machine and from a
peer. It stays on the request, is posted into an Inbox thread when the request has one, appears in any stalled
notice and is read with `sessions get`. `REQUEST_PROTOCOL` (`request-protocol.ts`) tells agents a partial
wakes no one and the final must stand on its own; the wire contract was updated.

## Acceptance scenario

- **Seed:** requester session A with four open requests to worker B (local) and one to a peer worker.
- **Action:** B sends one `--partial` reply to each request; the peer worker sends one partial.
- **Expected:** no new turn or steered input in A; each event is `received`; `sessions get` shows the
  partial; a later final from B wakes A exactly once.
- **Replayable offline:** yes for local; the peer path needs a second scratch instance
