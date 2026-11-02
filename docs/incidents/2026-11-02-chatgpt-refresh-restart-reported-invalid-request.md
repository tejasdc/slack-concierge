---
failure: The daily ChatGPT history refresh reported a valid request as invalid while Thinkering restarted.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# ChatGPT history refresh received 400 during a Thinkering restart

## What was seen

At 06:30 Eastern on November 2, the scheduled refresh waited 90,116 ms for
Thinkering, then Concierge answered 400. The service recorded `OWNER_ERROR` and
failed for the day. Thinkering startup records were present at the same time.

## Cause

The refresh owner's generic error handler classified any non-owner exception as
400. A private capability disconnect is a temporary availability failure, not an
invalid refresh request. The earlier 400 response did not retain the original
exception, so the exact disconnect that occurred on November 2 is not proven.

## Fix

The refresh owner translates private capability disconnects and server errors
to a 503 with `SOURCE_REFRESH_UNAVAILABLE`, including in its remembered pass.
The scheduled host job reads that pass before it retries a temporary failure
within its existing service window. Other invalid requests still answer 400.

## Acceptance scenario

- **Seed:** A valid ChatGPT source refresh request while the private Thinkering capability is temporarily unavailable.
- **Action:** Restore the capability within the scheduled service's run window.
- **Expected:** Concierge answers 503 for the unavailable attempt; the host job observes its result, retries, and reports a completed refresh without a daily service failure.
- **Replayable offline:** yes (a controlled capability refusal and recovery can replace a production restart).
