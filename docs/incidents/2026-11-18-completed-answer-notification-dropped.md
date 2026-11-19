---
failure: A completed answer with explicit notification lost its flag when its evidence said it was not checked live.
date: 2026-11-18
fix_commits: []
cause_status: confirmed
---

# Requested notification dropped on a completed answer

## What was seen

At 7:15 PM Eastern, Tejas asked about the sandbags and said “Notify me.”
The reply to request `43c09b8b-2db0-49b4-a030-d44d622701a4` was accepted
as completed with `--not-checked`. Its explicit `--notify` flag was dropped.
The human request nevertheless triggered a send for the exact final post at
7:16:18 PM Eastern (delivery decision 5648). A later manual post triggered
decision 5650 at 7:17:03 PM. These records establish the recorded sends.

## Cause

Reply admission required checked evidence for an explicit completed-final
notification. An informational final was ineligible. Separately, quiet filing
could consume a covered human notification arm without emitting a notification.
The sandbags dispatch was work, and the human arm succeeded on its ordinary
completion path.

## Fix

Completion and exact new answer words govern explicit final delivery. Evidence
records what was checked. Quiet filing skips unsolicited attention, and covered
human arms are consumed with the corresponding requested notification
[decision: notify-me-is-the-command].

## Acceptance scenario

- **Seed:** separate disposable Inbox threads for an ordinary informational
  request, a marked informational request, and marked work.
- **Action:** explicitly request notification on an informational final and
  on a completed work final with unchecked evidence. Answer the marked
  informational request normally.
  Post progress and a failed final to the work request.
- **Expected:** each answer emits one requested event for its exact post.
  Progress and failure emit no requested event and preserve the pending work arm.
- **Replayable offline:** yes with `bun bot/scripts/inbox-requested-notification-fixture.ts`.
