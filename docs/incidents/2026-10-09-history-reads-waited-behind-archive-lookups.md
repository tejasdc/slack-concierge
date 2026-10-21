---
failure: Opening a thread's history waited about three seconds because both readers were busy scanning old transcripts for update links.
date: 2026-10-09
fix_commits: [1da6d417]
cause_status: confirmed
---

# Interactive reads queued behind archive attribution lookups

## What was seen

Installed evidence on October 9 showed both readonly read executors scanning historical transcripts (archival attribution
used by update links) while an interactive history request waited about three seconds.

## Cause

The foreground gateway (`bot/src/foreground-gateway.ts`, `bot/src/foreground-read-pool.ts`) admitted all reads to two
executors without class. A burst of archival attribution lookups could occupy both, leaving no lane for ordinary reads.

## Fix

1da6d417 classifies archival attribution routes (`bot/src/native-read-routes.ts`), admits at most one active archive
read, and keeps separate bounded waiting budgets, so ordinary reads pass the archive backlog using the existing readers.
`bot/scripts/foreground-pool-fixture.ts` serves an interactive read in under a millisecond behind 64 queued archive
requests.

## Acceptance scenario

- **Seed:** Gateway with its two readonly executors; 64 slow archival attribution requests queued.
- **Action:** Issue one interactive history read.
- **Expected:** It is served promptly (no wait behind the archive queue); at most one archive read runs at a time.
- **Replayable offline:** yes (the foreground pool fixture)
