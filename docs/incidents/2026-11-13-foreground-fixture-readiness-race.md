---
failure: Candidate preparation rejected a healthy release after its isolated owner readiness data was read before writing finished.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Candidate preparation parsed incomplete fixture readiness data

## What was seen

Candidate `d8a52d1eaee9949903f080d71acc1f7e4b2b97fc` failed the presentation release check during candidate preparation. The retained child trace identifies `JSON Parse error: Unexpected EOF` at the foreground composition fixture's read of `owner-ready.json`. The owner had already completed its isolated area, topic and attachment requests. The detached controller restored last-known-good `ab5df4b2a9a0d79463d4efa2c6666569744e50df`.

## Cause

The owner created `owner-ready.json` with a direct write. The parent used existence of that path as its readiness signal, then immediately parsed it. File creation precedes completion of the write, so the parent could read partial JSON. The recorded parse error at that exact read, after the owner completed its setup requests, matches this race. The candidate's preceding cache diagnostic change did not touch the fixture; commit provenance alone does not establish it caused this failure.

## Fix

Write the complete JSON to a pending file in the fixture's private scratch directory, then rename it to the readiness path. The parent sees the final path only after the write completes. No production state, deadline, or release gate is changed.

## Acceptance scenario

- **Seed:** Start the foreground composition fixture with an owner whose readiness write is slow enough that the parent can poll while it is in progress.
- **Action:** Let the parent observe the readiness path and parse its contents.
- **Expected:** The final path appears only after the complete JSON is written; the parent never parses partial readiness data, and the unchanged release gate proceeds to its remaining checks.
- **Replayable offline:** yes (isolated scratch fixture; no production database is needed).

This incident repair was committed without running tests or reviews, as requested. Installation and health proof belong to the external supervisor and detached controller.
