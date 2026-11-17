---
failure: Explicit notification requests after another command silently lost their phone notification mark.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# Explicit notification requests rejected after another command

## What was seen

The November 17 brittleness sweep reproduced four requests returning no result mark
on installed revision `6e6d2d059`:

- `Fix the login bug and notify me when it is done`
- `Fix the login bug, notify me when it is done`
- `Fix this, and send me a notification when done`
- `Fix it and ping me once done`

## Cause

The admission reader recognized the explicit notification phrase but required an
approved preceding phrase. Earlier repairs added entries to that list, so an
ordinary coordinated command could still silently lose its requested phone notice.
The delivery path repaired in PR 914 was separate: it could faithfully deliver an
arm only after admission had created one.

## Fix

An explicit notification instruction qualifies wherever it occurs. Context can
exclude a mention when the notification itself belongs to a factual question,
prohibition, quotation, report, or command/configuration discussion. The existing
help-needed question path remains independent. Reminders retain scheduled marks,
and machine diagnostics after the bug-report delimiter remain excluded.

The governing notification clause matters. A report elsewhere in a work request
does not negate its notification instruction: `Fix the bug I mentioned and notify
me when done` qualifies. A separately stated request after `I changed the password,`
also qualifies. Conversely `I asked you to fix it and notify me yesterday` reports
an earlier request. Negating an omission (`do not forget to notify me`) does not
prohibit the embedded notification. These distinctions replace approved imperative
lead-ins; they do not add a second positive lead-in list.

## Replay and custody

Run from `bot/`:

```
bun run scripts/notification-request-invariant-fixture.ts
bun run scripts/agent-test-notification-receipt-fixture.ts
bun run scripts/inbox-requested-notification-fixture.ts
```

The admission fixture exercises the actual owner and all five required live-probe
sentences. Its authenticated agent receipts retain a diagnostic production-reader
result and `humanNotificationArmed:false`. Agent origin, canonical human mark,
notification arms, and attention events remain unchanged. A retry returns the
retained observation; Reader, ordinary agent messages and issue reports do not
acquire this diagnostic authority.

The parent audit compares the candidate against the preserved installed reader on
311 retained human Inbox messages, without replaying or rewriting them. It found
one newly marked current notification request and none that stopped marking;
reported regression complaints and discussion of the command remain unmarked.
Raw private input text stays in the task's private evidence, outside Git.

The classifier remains a deterministic wording rule with bounded demonstrated
coverage. These source fixtures and audit do not establish installation, a human
phone arm from an agent-authored test, or physical phone display. The live admission
receipts belong to the release acceptance report.

## Acceptance scenario

- **Seed:** An isolated canonical owner with an authenticated marked-agent capture source.
- **Action:** Admit the four command-and-notify sentences above and `did you notify me?` through its normal capture entrance.
- **Expected:** Retained diagnostic receipt marks are result/result/result/result/null; agent provenance is preserved, authoritative human marks stay null, and no notification arm or attention event is created.
- **Replayable offline:** yes; the two new fixtures run the production classifier and disposable owner.
