---
failure: One failed nightly repair stopped every later nightly finding in its lane from reaching its owner, because the hand-off used a prerequisite to pace its requests.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Nightly findings were refused without reaching the sessions that owned them

## What was seen

thnkr.ing's nightly review (concierge:7519) hands each finding to the session that owns it,
two at a time. On 2026-11-01 two requests settled "failed" (concierge:7685 and 7499, each with
part of its work shipped) and 7 + 7 later requests settled `dependency_failed` without reaching
their owners. On 2026-11-02 one honest failed reply (concierge:7446, request e31e3a2d) refused
15 more, among them Tejas's Uber Eats complaint and the session-search writer freeze. Each night
the review re-sent them by hand.

## Cause

The hand-off (thinkering `scripts/nightly-hand-off.mjs`) chained each finding with
`--after-request` on the one sent two before it, only to keep two of the review's requests in
flight. `--after-request` is a prerequisite: dispatch settles a continuation `dependency_failed`
when any prerequisite settles failed or canceled. The findings were unrelated to each other, so
a prerequisite was the wrong primitive for pacing.

## Fix

`sessions ask --after-settled <request-id>` stores the named requests as `pace`, separately from
`after`. Dispatch holds a paced request until each named request has any outcome and then
delivers it; outcome is never consulted. The hand-off uses it instead of `--after-request`.

## Acceptance scenario

- **Seed:** a session sends request A to another session, then request B with `--after-settled A`.
- **Action:** A's recipient closes A with `--work-disposition failed`.
- **Expected:** B is admitted to its recipient (status not `dependency_failed`); a request C sent
  with `--after-request A` instead is still settled `dependency_failed`.
- **Replayable offline:** no (needs two live sessions and the request dispatcher).
