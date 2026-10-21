---
failure: Concierge updates failed their pre-install checks because the server was busy with agents, with nothing wrong in the new version, and the failure record did not say which check failed.
date: 2026-10-10
fix_commits: [94c4b283, cca6d450, 17db53ff, 31442415, 6a190467, b4f44aec]
cause_status: confirmed
---

# Updates failed their timed checks under host load, with no recorded cause

## What was seen

The release runner's isolated candidate checks time the candidate owner's startup and reads. At host load 70–140 on
October 9–10 they missed their deadlines at least three times with a sound candidate. Two failed updates (October 9
7:16 PM, October 10 12:10 AM) recorded only Bun's source excerpt, so autonomous repair parked for lack of a cause.
Retained attempts spent 36.8 s and 41.1 s loading the scratch owner within a 45 s deadline; another exhausted a 20 s
first-checkpoint wait; a catalogue request returned 503 after 1,010 ms; a claim fixture timed out before importing the
owner when four lifecycle workers started together. Later recurrences on the same day are in the
[lock and corruption record](2026-10-10-database-lock-and-corruption.md).

## Cause

- The runner ran at default CPU weight beside a dozen agent runs.
- `deployment-application-check.ts` kept the first 1,500–2,000 characters of the child's stderr (the throwing line's
  excerpt); the fixture, deadline and phase lines after it were cut.
- Cold schema setup committed each DDL phase separately (`state.ts` base DDL and legacy upgrades; five store constructors
  in `presentation-message-worker.ts`), paying a durable commit per statement on a contended disk.
- The catalogue reader (`presentation-session-reader.ts`) waited on SQLite during its opening probe instead of reporting
  "indexing".
- The release check launched its short claim proof alongside heavier fixtures.

## Fix

94c4b283 then cca6d450 keep Bun's `error:` line onward from a failed check; cca6d450 also runs the runner at
CPUWeight/IOWeight 1000 like the owner. 17db53ff and 31442415 group schema phases into immediate transactions with
startup timing. 6a190467 opens the catalogue with no startup lock wait and maps contention to the existing indexing
response. b4f44aec starts the claim proof before the concurrent fixtures. No deadline was lengthened.

## Acceptance scenario

- **Seed:** A known-good candidate; host loaded with CPU- and disk-heavy work in the agent slice.
- **Action:** Run the release's candidate checks.
- **Expected:** All checks pass within existing deadlines; a deliberately failing fixture's record names the fixture,
  deadline and last phase.
- **Replayable offline:** partly (failure-record content yes; load timing needs a comparably loaded host)
