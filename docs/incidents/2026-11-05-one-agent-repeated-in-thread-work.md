---
failure: One working agent appeared repeatedly in a thread's work summary because it held several requests.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# One agent repeated in thread work

## What was seen

Tejas saw the same “Slowness thread coordinator (continued)” row seven times in the Work here panel of a thread. The adjacent conversation also showed routine handoff cards, making the thread difficult to read.

## Cause

The topic's current-work projection emitted one worker row for each open request. Separate requests to the same destination session are separate deliveries, but they are not separate working agents. This record covers the duplicate Work here rows; conversation-card placement is a separate app projection.

## Fix

Group current worker rows by exact destination session identity, keeping the newest reported progress among its open requests. Accepted session handoffs move open requests to the successor, so the current destination remains the displayed worker. Keep request receipts individually addressable in the work lane.

## Acceptance scenario

- **Seed:** A marked test topic has two open requests to one running agent and one open request to another running agent.
- **Action:** Read the topic's current-work projection.
- **Expected:** Work here has two worker rows, one per distinct current agent; the first agent's row shows its latest progress, while all three request receipts remain separately readable.
- **Replayable offline:** yes (seeded owner request and progress records can be read through the topic projection).
