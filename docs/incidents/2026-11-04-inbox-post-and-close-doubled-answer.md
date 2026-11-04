---
failure: One Inbox answer appeared twice when its router posted in a thread and then closed the turn with similar text.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# One Inbox answer appeared twice

## What was seen

At 12:44 PM Eastern, the "No more 'no answer within three minutes' notices" thread showed two nearly identical Inbox messages. Tejas reported the pair at 12:47 PM, then reported that even a closing line saying "Answered in the thread" was an unwanted extra message.

## Cause

The Inbox router deliberately posted an answer into the thread. Its turn result was also projected as a conversation reply for the same opening input. The older routing-only suppression applies to a handoff followed by an explicit done outcome, so it did not cover a substantive post followed by a closing result. The two stored events were distinct; the duplicate was in the thread projection.

## Fix

The owner now follows the opening message to its thread and records a stable marker when that same turn posted there. Both thread readers omit a marked closing result while keeping it in the raw session transcript. Startup reconciles older pairs, including replies inside existing threads, and the prepared-view upgrade removes their already projected copies. A result remains visible when the turn did not post in its thread.

## Acceptance scenario

- **Seed:** One marked Inbox turn begins in a thread and retains its opening input.
- **Action:** It posts an answer in that thread, then ends with similar closing text.
- **Expected:** The thread shows the post once; the result remains in session history. A different turn that makes no post still shows its closing answer. The previously reported pair also shows one answer after the prepared view upgrades.
- **Replayable offline:** yes (with a retained turn, post and result in a disposable ledger)
