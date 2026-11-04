---
failure: A background-job reminder kept retrying every ten seconds after its action identity conflicted with an earlier accepted reminder.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Background-job reminder conflict loop

## What was seen

On November 4 the server logged 836 `background_job_notice_skipped` conflicts in roughly two hours for the 15-minute reminders on two turns. The same failure was still appearing later that day, every ten seconds for one job. The receiver had already accepted the reminder's action identity.

## Cause

The watch reused one action identity for each job and threshold, but regenerated the reminder with the job's current age and whether a Concierge update was waiting. After a restart, an already accepted reminder could be retried with changed words. The receiver correctly refused the changed payload, while the watch treated that permanent conflict as a transient failure.

## Fix

The reminder's words now use its fixed threshold. The separate update-wait reminder also uses a fixed threshold. When an older version of the same service notice was already accepted for the exact session, source run and action identity, the watch records it as told and stops retrying. Other admission errors remain retryable.

## Acceptance scenario

- **Seed:** retain a service reminder at the 15-minute threshold with the old age-dependent words, and resume its still-running background job after the owner restarts.
- **Action:** run the background-job watch past the next ten-second tick and past the next minute boundary.
- **Expected:** the existing accepted reminder stays unchanged, the job shows its first notice as told, and the conflict is not retried every ten seconds. A new job receives one reminder with fixed words for its threshold.
- **Replayable offline:** yes, with a temporary owner ledger and controlled clock.
