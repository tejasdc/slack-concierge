---
failure: Stopping the curiosity-engine think-aloud session ended one run while each waiting speech sentence restarted it.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Stop left the think-aloud speech queue running

## What was seen

Tejas reported on November 2 that the think-aloud session kept responding to individual sentences after he tried to stop it. The live session had one running Codex turn and 135 pending inputs when the repair began. After its exact active run was stopped and the session paused, a diagnostic ledger snapshot showed 133 queued turns: 131 Canvas speech inputs, one direct human instruction to stop the sentence-by-sentence work, and one unrelated service return. None of those queued turns had provider admission intent or acknowledgement. The accepted human words were retained, in order, between 22:35:09 and 23:20:46 UTC.

## Cause

The Canvas submitted each finalized speech segment as its own durable input. The session owner's Stop operation marked only the exact running turn for cancellation; queued turns stayed eligible. When one run stopped, the next queued sentence could start a new run. The prior exact-run rule protected newly arriving inputs and uncertain provider effects, but it did not express the person's expectation that Stop ended the already waiting line.

## Fix

The session owner now cancels the waiting turns in the Stop transaction, retaining their accepted input text and canceled receipts. A queued retry that may have reached the provider is marked uncertain and cannot replay. Retained queue intents without a turn are canceled too, so restarting the owner or continuing a paused session cannot revive them. A separate clear-queue action lets an older stopped session recover its waiting line. The paired Thinkering change batches speech into one ordered transcript with per-segment speaking times before admission.

## Acceptance scenario

- **Seed:** A think-aloud session with one running turn, three unadmitted speech inputs queued behind it, and one accepted input with a queue intent but no turn. Retain the original input text and action identities.
- **Action:** Stop the exact active run, then allow the owner to recover and inspect the session queue.
- **Expected:** Stop cancels the running turn and all four waiting inputs. Their original words remain in history with canceled receipts. No old sentence starts a new run after recovery. A newly submitted transcript remains eligible as one new input.
- **Replayable offline:** yes (isolated owner ledger and a provider stub that confirms Stop)
