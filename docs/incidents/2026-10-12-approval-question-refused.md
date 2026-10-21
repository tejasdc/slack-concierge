---
failure: An agent could not ask Tejas for an approval that a permanent decision explicitly reserves to him, because Concierge refused every approval question.
date: 2026-10-12
fix_commits: [786a8f65]
cause_status: confirmed
---

# A required approval question was refused

## What was seen

On October 12 an agent proposing a disk-priority trial needed Tejas's approval under
[decision: machine-wide-resource-changes-need-his-approval], but the question gate refused it, leaving no path to ask.

## Cause

The question gate (`bot/src/answers-to-tejas.ts`) implemented [decision: act-then-tell] by refusing permission and
approval questions outright, with no exception for actions a permanent decision reserves for him.

## Fix

786a8f65 adds `--only-he-can approval` with `--decision-id` and `--approval-action` on `needs_you` outcomes and
`needs_decision` replies (`router-sessions.ts`, `session-communication.ts`, `session-topics.ts`). The owner
(`decision-approval.ts`) reads the installed decision record, requires it to be permanent and unsuperseded, and checks the
action against a closed vocabulary (processor/memory/disk × priority/throttling/slots/limit/quota). Other permission
questions stay refused.

## Acceptance scenario

- **Seed:** The installed permanent machine-resource decision; an agent turn.
- **Action:** Declare `needs_you --only-he-can approval --decision-id machine-wide-resource-changes-need-his-approval
  --approval-action disk-priority`; then the same with `--approval-action deploy-schedule`.
- **Expected:** The first is accepted and raises Needs attention; the second is refused.
- **Replayable offline:** yes (scratch ledger with a decision-record fixture)
