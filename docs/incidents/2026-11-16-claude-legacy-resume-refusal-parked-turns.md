---
failure: Claude conversations older than Claude's owner header could not be resumed, and each refused turn parked with its requests counted as live work.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Refused Claude resumes parked their requests silently

## What was seen

At 06:44 UTC on 2026-11-16 concierge:8196 received three work requests. Its turn ended after six
seconds, was parked as an ambiguous end, and its requests stayed open with nothing running. The
requester only learned of it from the fifteen-minute overdue notice; the Inbox router then cancelled
and re-sent the work by hand.

## Cause

The owner log for the turn records the launcher's refusal: "Claude exact resume 04be6117…: original
transcript header binding is missing or malformed". The November 13 guard
([record](2026-11-13-claude-exact-resume-ambient-account.md)) requires an exact resume's transcript to
begin with Claude's session-owner header. Claude Code did not write that header when 8196's transcript
began on November 4, so every resume of an older conversation was refused before Claude started.
Between November 13 and 16 this refused 29 turns in 9 Claude sessions.

The turn runner could not tell the launcher's refusal from Claude crashing: both read as "Claude Code
ended before acknowledging the initial user message", which parks the turn as ambiguous. A parked turn
is not an ended turn, so its requests stayed open as live work; no stall, report-back or Inbox
recovery applied, and no automatic resume exists for an ambiguous Claude park.

## Fix

- A transcript whose first row is not a session-owner header (written before Claude added it) resumes
  on Concierge's verified account choice, as fresh launches do. Such transcripts are shared by every
  account home. A session-owner header that is present but malformed still refuses.
- Every launcher refusal before Claude starts is printed after a fixed marker with exit code 78
  (`bot/src/claude-launch-refusal.ts`). The turn runner reads it as proof nothing was sent: the turn
  fails at once with the launcher's reason, counted only against that conversation's retry budget, and
  its requests settle failed and return to their requester for a new owner.
- At startup the owner fails the turns already parked as unacknowledged Claude launches. Failing replays
  nothing; requests still open return to their requester, settled ones stay settled.

## Acceptance scenario

- **Seed:** a Claude conversation whose transcript begins with an ordinary row, and a malformed
  session-owner header.
- **Action:** resume each through the launcher.
- **Expected:** the first resumes on the verified account; the second exits 78 with the marker and the
  turn fails at once with that reason instead of parking.
- **Replayable offline:** yes (`bot/scripts/claude-exact-resume-check.ts`).
