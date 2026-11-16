---
failure: A recorded unsent request could appear idle and close against an unrelated later answer in its thread.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Unsent requests and exact direct-answer evidence

## What was seen

Source inspection and the isolated legacy-completion fixture reproduced two contract gaps:
an open request without a dispatch produced an idle thread status, and its completion
accepted any later assistant answer in the topic. A reopened request also accepted a
generic later post without binding it to the request's source.

These are independently reproduced defects, not a proven explanation for the November 15
group-chat incident. The initial claim that its request was never dispatched was incorrect:
the compact prepared item omitted its large dispatch/source arrays. The exact ledger row
and retained creation event show request `req:c715b4e8-b689-4bdc-ab28-9085b9dac106` was created
with dispatch `7760ed6c-63b6-4020-ac2b-381cf817dda7` at 03:26:11 UTC on November 16, and later
linked two more dispatches before closure at 14:54:16 UTC. Its cited shared answer therefore
does not exercise the no-dispatch loophole. Compact preview omissions cannot establish
absence. Whether the delivered implementation met every original requirement remains a
separate acceptance judgment.

## Cause

Thread membership and a later timestamp were treated as sufficient evidence for a direct
completion. The status projection counted workers but not open undispatched obligations.

## Fix

Direct completion requires a later non-service, non-forwarded post replying to one of the
exact request source messages. A dispatch answer must go through the existing linked-work
checks. Reopened direct answers use the same source boundary and the reopening time.
An already accepted latest dispatch can supply a new checked completed final after reopening;
only its unsuperseded final identity or exact forwarded post is accepted. The regression
fixture reproduces and guards the earlier over-narrow refusal of that late result. A new
post merely naming the same dispatch cannot substitute for its exact final.
Router obligations and prompts label undispatched requests explicitly. Both thread status
assemblers retain an unsent count and warning, including alongside a worker. A waiting
worker plus unsent request uses the existing routing status so the web view renders the
warning while retaining the worker's details. Existing prepared topics refresh once.

This enforces evidence identity. It cannot determine whether an answer's prose or a builder's
implementation satisfies every clause of a human request. Exact linked finals, later-return
finals, shared checks, and the shared-failed-check exception retain their existing rules.

## Acceptance scenario

- **Seed:** A human topic with an open request and no dispatch; another source in the same topic, an unrelated worker answer, and an Inbox successor.
- **Action:** Read router obligations and canonical/prepared status. Attempt completion with the sibling answer and forwarded answer. Then cite a direct answer replying to the exact source. Reopen and retry the unrelated evidence.
- **Expected:** Unsent status remains explicit; unrelated evidence refuses; the checked direct answer can close; reopening retains the exact-source boundary. Mixed worker waiting preserves both the unsent warning and worker details.
- **Replayable offline:** yes, `cd bot && bun run scripts/legacy-topic-completion-fixture.ts`.

The sealed release also carries `control/bot/scripts/legacy-topic-completion-fixture.js`.
Run that installed bundle against its disposable ledger after deployment; a passing source
fixture alone does not establish installed behavior.
