---
failure: Concierge on the Mac reported itself frozen when the laptop had simply been asleep, sending the repair agent after false alarms.
date: 2026-10-11
fix_commits: [fadf90fd]
cause_status: confirmed
---

# A napping Mac opened freeze notices

## What was seen

On battery the Mac dark-wakes for upkeep about every 18 minutes; each wake read as an 18–35 s owner loop stall with
almost no CPU. The 7:00 AM one on October 11 opened a freeze notice for the repair agent.

## Cause

`bot/src/owner-responsiveness.ts` measured loop lag from a monotonic clock that excludes sleep, so the tick after a wake
looked like a long stall of the owner. Nothing compared the stall with the machine's sleep and wake times.

## Fix

fadf90fd asks the kernel (`sysctl` sleep/wake times) for stalls of 5 s or more and logs the stall as sleep, without
counting it, when either sleep or wake falls within a minute of it. Smaller lags pay nothing.

## Acceptance scenario

- **Seed:** The responsiveness watch with an injectable lag sample and sleep/wake source.
- **Action:** Report a 25 s stall that begins 5 s after a recorded wake; then a 25 s stall with no sleep or wake nearby.
- **Expected:** The first is logged as sleep and opens no repair notice; the second counts as a freeze.
- **Replayable offline:** yes with injected times (real sleep behaviour needs the Mac)
