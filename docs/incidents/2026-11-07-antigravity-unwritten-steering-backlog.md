---
failure: Google Inbox follow-ups were accepted during a long answer but not written to the provider, leaving open requests behind after an update.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Google Inbox follow-ups stranded behind live steering

## What was seen

After the Inbox moved to Google's Antigravity agent, follow-up requests were accepted into an active turn but absent from its retained provider journal. The next deployment failed their steering attempts. Twenty-one failed, unsent attempts remained attached to the Inbox session; several exact obligations had already settled, while others were still open. New work continued to arrive behind a long answer.

## Cause

The executable provider contract advertised live steering even though the Antigravity CLI's serial answer path did not guarantee durable pickup. The owner attached follow-ups to the active turn and kept them in memory. The provider session documentation already described sequential turns, so the executable contract contradicted the documented behavior. Recovery could detach one proven unsent input, but no startup path scanned those Antigravity attempts. A deployment exposed the gap.

## Fix

The provider contract disables live steering for Antigravity. Each new follow-up enters the existing durable session turn queue and runs after the current answer. On startup and after adopting a prior run, recovery scans failed, never-written steering attempts. It requeues the original accepted input only when its exact request remains open, preserving identity and order. Sent or ambiguous attempts, completed receipts, answered or canceled communication requests, and closed thread upkeep are excluded.

## State card

- **Entity and writer:** the Concierge owner writes accepted inputs, steering evidence, and durable queued turns.
- **Identity:** the accepted input ID is retained; no new message or request is fabricated.
- **Acceptance:** a follow-up is queued as a separate turn and later receives a provider run; a recovered input is eligible only with a failed attempt and no provider-send evidence.
- **Retained state:** steering attempt status, provider-send evidence, exact request outcome, and turn queue survive restart.
- **Lifetime:** recovery runs at owner startup and after hosted run adoption; future follow-ups use the durable queue directly.
- **Old readers:** no schema or wire format changes.
- **Failure trace:** follow-up accepted during Google answer; steering attached in memory; update adopts run; no provider write; attempt fails; no startup requeue; request remains open.
- **Falsifying check:** a live request sent during an active Google answer appears as a queued distinct turn, then runs after the answer; old failed never-written open inputs appear once in the queue while settled inputs do not replay.

## Acceptance scenario

- **Seed:** a Google Inbox turn is running; one follow-up remains open and another exact request has settled; both have failed, never-written steering attempts.
- **Action:** restart the owner and admit another follow-up during the running Google answer.
- **Expected:** the open old follow-up and new follow-up occupy durable turns in accepted order; the settled request is not replayed; each eligible turn runs once after the active answer.
- **Replayable offline:** yes for queue and restart recovery; live provider delivery requires the installed system.
