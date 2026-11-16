---
failure: Google refused a Flash High turn for quota while Concierge reported that its allowance still had room.
date: 2026-11-07
fix_commits: []
cause_status: best-explanation
---

# Google's five-hour refusal was paired with an earlier allowance reading

## What was seen

At 06:05:18 UTC Google refused a zero-token Gemini 3.8 Flash High turn, saying the individual quota reset in about 70 minutes. Concierge filed a reading-disagreement notice. Its retained shared Gemini five-hour readings showed 100% used at 06:04:20, 99.5891% used at 06:05:15, and 100% used at 06:05:30. The reset at 07:15:16 UTC matches the refusal. The separate weekly Gemini and Argon readings were below 100% at that time.

## Cause

The refusal handler joined an allowance refresh that could have begun before the refusal. Its 99.5891% result was real provider output, but was not evidence of capacity for that Flash High turn. The retained logs do not prove the exact overlap of the CLI calls, so the refresh race is the best explanation of the mismatch. A small residual balance may also be insufficient for a new turn; the provider does not report that turn's required quota in this reply.

## Fix

On a zero-token quota refusal, Concierge finishes an in-progress check and then requests a new allowance reading. It uses the post-refusal reading's spent window to set the hold until Google's reset. If that reading still shows a residual balance, it preserves Google's number and reports the unresolved disagreement rather than inventing a full allowance.

## Acceptance scenario

- **Seed:** A Gemini Flash High turn starts while an allowance refresh has already begun and that refresh reports a small five-hour residual balance; Google's turn result refuses it for quota and a subsequent structured allowance reply reports the five-hour window spent.
- **Action:** Concierge handles the zero-token refusal.
- **Expected:** The first refresh completes, a second refresh begins afterward, the saved reading shows the shared Gemini five-hour window spent, and the held turn is timed to that window's reset without a false disagreement notice or replay.
- **Replayable offline:** yes (replace the Google CLI with a bounded fixture returning the two ordered readings and a zero-token refusal).
