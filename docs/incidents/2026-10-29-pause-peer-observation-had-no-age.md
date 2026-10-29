---
failure: Pause status could not say when the Mac last answered while showing its saved state.
date: 2026-10-29
fix_commits: []
cause_status: confirmed
---

# Pause status lacked the Mac observation time

## What was seen

The nightly review found 39 Thinkering pause-status reads in 24 hours, with p50 3 ms,
p95 6.3 s and a maximum of 7.2 s. The slow reads clustered near 7.19 s. The report
attributed those waits to a live Mac peer read. Current Concierge source already
performs that peer read in background reconciliation; the status handler reads only
retained local rows. The same-window server and browser trace later established
that the seven-second read waited behind an 8.3-second Inbox topic transaction
on the canonical owner loop. The pause handler itself took about 1 ms once it
started. The Mac peer call was not in the read path.

The retained peer row had a snapshot and the time of the latest attempt, but no time
for the latest successful answer. A failed attempt replaced the attempt time, so the
status could not truthfully say how old the saved snapshot was.
The first installed response exposed a seven-day-old successful observation still
marked reachable: reconciliation had stopped checking a peer after an unpaused
generation was acknowledged.

## Cause

The last attempt and last successful observation were represented by one timestamp.
The status response omitted observation age. This explains the missing freshness
information. The latency came from the pause route being classified as a live-owner
read even though all its input is retained.

## Fix

Store the successful observation time separately and retain it after failed checks.
Serve that time and its age with the saved snapshot. Keep the existing background
reconciliation as the only peer request path for status.
Keep checking unpaused peers in that existing loop at a one-minute cadence; keep
the five-second paused cadence for Stop receipts. Check before the first pause too.
Route the pause read to the existing independent read executors and assemble its
ledger reads within one consistent snapshot. An Inbox command can then occupy the
owner loop without holding this screen read.

## Acceptance scenario

- **Seed:** The cloud has one successful Mac pause snapshot, then the Mac is unreachable.
- **Action:** Read pause status while the background peer check is timing out.
- **Expected:** The read returns without waiting for that check or a busy owner-loop command, marks the Mac unreachable, preserves its previous snapshot and last reached time, and reports an increasing age.
- **Replayable offline:** yes (isolated owner and peer fixture); live acceptance requires the Mac to be unreachable during the read.
