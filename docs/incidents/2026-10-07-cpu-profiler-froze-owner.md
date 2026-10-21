---
failure: The on-demand CPU profiler added to diagnose freezes itself froze Concierge for 20-40 seconds every time it ran.
date: 2026-10-07
fix_commits: [8f61c14d]
cause_status: best-explanation
---

# The diagnostic CPU profiler froze Concierge each time it was started

## What was seen

On 2026-10-07 every `kill -URG <owner pid>` used to profile the owner during stalls froze the owner for 20-40 s, so
taking a diagnosis caused the symptom being diagnosed. Twice a profile was followed within minutes by the owner
growing to about 40 GB of memory.

## Cause

The profiler was added in 266b7624 (`bot/src/owner-cpu-profile.ts`): SIGURG runs `bun:jsc`'s `profile()` around a
20-second sleep at a 1 ms sampling interval, then summarizes all stack traces on the owner's own thread and writes them
synchronously. Best explanation: the sampling and the in-process summary of tens of thousands of stacks held the owner's
event loop. Not observed: which part held it, and whether the profiler contributed to the 40 GB runaways (their
confirmed cause is the output re-parse in [the 40 GB record](2026-10-07-output-reparse-froze-owner-40gb.md)).

## Fix

8f61c14d: SIGURG is acknowledged and refused (`owner_cpu_profile_refused`) unless the service runs with
`CONCIERGE_OWNER_CPU_PROFILE=1`. The same commit's memory cap was removed by 23fe1c7f before it was installed; the
profiler stayed off. AGENTS.md records the rule.

## Acceptance scenario

- **Seed:** an owner started without `CONCIERGE_OWNER_CPU_PROFILE`.
- **Action:** send SIGURG while measuring event-loop lag.
- **Expected:** a single `owner_cpu_profile_refused` log line, no profile file, and no measurable lag increase; with
  the variable set the profile runs (its cost then measured in isolation before re-enabling in production).
- **Replayable offline:** yes (local owner process against a scratch state directory)
