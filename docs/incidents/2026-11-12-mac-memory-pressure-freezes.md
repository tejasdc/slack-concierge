---
failure: The Mac's Concierge kept freezing for tens of seconds while the Mac sat at full swap, and a burst of released held work or per-session helper processes made it worse.
date: 2026-11-12
fix_commits: []
cause_status: best-explanation
---

# The Mac's Concierge froze while the Mac ran out of memory

## What was seen

Every `owner_unresponsive` since Nov 4 (eight on Nov 10) used 1.2–1.8 s of processor across about 65 s of
blocking, single blocks of 12–21 s, with 14.1 of 15.4 GB of swap in use and no agent running.

## Cause

Best current explanation, not yet observed as page-in counts: the Mac is permanently near memory
exhaustion, macOS compresses or swaps out the idle owner, and each timer wake faults its pages back in
against a contended disk. Burst starts of held work (each Claude session ~0.5 GB, plus ~90–130 MB for its own
Playwright copy) add demand but are not required.

## Fix

Paced starts with a memory-pressure gate and agents that snooze themselves when told the machine is crowded, one shared Playwright server, and page-in/pressure/swap evidence on
every freeze record (docs/plans/2026-11-12-mac-held-work-pacing.md). The cause stays "best explanation" until a
freeze record shows the page-ins.

## Acceptance scenario

- **Seed:** a paced machine with eight queued agent turns and an exhausted start budget.
- **Action:** claim repeatedly.
- **Expected:** three starts per window in the agent's order, each other turn held with its place and time;
  a human message still starts at once.
- **Replayable offline:** yes (`bot/scripts/start-pace-fixture.ts`)
