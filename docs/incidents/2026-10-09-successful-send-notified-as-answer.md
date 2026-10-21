---
failure: A successful text send produced a reading item and a phone notification ("has an answer to read: Sent to Sai") on top of the send's own notice.
date: 2026-10-09
fix_commits: [be75a379]
cause_status: confirmed
---

# A confirmation that a text was sent notified Tejas as an answer

## What was seen

After one text to Sai on October 9, the messaging agent's completed answer was filed as a reading item with a
notification, in addition to the send's own notice. Tejas: "why do I need a confirmation if it was sent? Just let me know
if it was not sent" [decision: sends-notify-only-on-failure].

## Cause

Every completed agent answer to a thread request was posted, filed for Tejas as a reading item and notified
(`postAgentAnswer` in `bot/src/session-topics.ts`). `sessions reply` had no way to say a completed answer needed no
reading; `--quiet-because` existed only on turn outcomes.

## Fix

be75a379 adds `--quiet-because` to `sessions reply --work-disposition completed`: the owner still posts the answer in the
thread with "Not sent to you: <reason>", still closes the thread request, but files no reading item and raises no
notification. Failed and `needs_decision` replies refuse the flag. The reason travels the Mac peer road (push, pull,
status) so Mac answers behave the same.

## Acceptance scenario

- **Seed:** An Inbox thread with a work request routed to an agent (local, and separately a Mac peer agent).
- **Action:** The agent replies `--work-disposition completed --quiet-because "sent as asked"`.
- **Expected:** One post appears in the thread with the quiet reason; the thread request closes; no question/reading item
  and no notification event are created. A `failed` reply with the flag is refused.
- **Replayable offline:** partly (local path yes; peer path needs a second instance)
