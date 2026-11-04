---
failure: A later message or a completed sibling request could close unfinished human work.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Unrelated evidence could close human work

## What was seen

ChatGPT Pro's read-only review of the installed recovery predicates found two
counterexamples. A request could be withdrawn using any later human message in
its thread, including “keep working.” Two requests drawn from different passages
of one message could also be treated as replacements because they shared the
source message. The review found these reachable predicates in the current source;
it did not claim either exact outcome had occurred in the production ledger.

## Cause

The Inbox request is the durable obligation, written by the Concierge owner on
the server. Its closure guard accepted temporal and thread proximity as a proxy
for withdrawal intent, and accepted shared provenance as a proxy for equivalent
task scope. Neither relationship proves the specific obligation was fulfilled or
withdrawn. Stop metadata on an agent attempt also flowed into human-task
withdrawal, while a forwarded human continuation that stalled before linking
could be skipped when the earlier task was closed.
One agent answer linked to several requests also qualified each for automatic
completion, without a separate check of each obligation.

## Fix

The owner requires exact retained withdrawal words and a request-specific link
for an agent's withdrawn or declined close. It refuses agent supersession of a
human task; each human obligation stays open until its own checked result or
Tejas's own withdrawal. Stop remains an attempt end. A forwarded continuation
is linked and reopens its request even when its agent attempt already stalled or
ended. A shared agent answer remains evidence for each request, but does not
automatically close any of them; the router must name the answer and check each
request separately. The Inbox router's command supplies the exact quote when it interprets a
natural-language withdrawal. Semantic interpretation remains an agent judgment;
the owner enforces quote custody, task identity and safe default-open behavior.

## State card

- Entity and writer: one Inbox request, mutated by the Concierge owner; an agent
  proposes changes through the command boundary.
- Identity: request ID, exact source input, exact linked agent attempt and
  idempotent action ID survive restart and retry.
- Acceptance: a command receipt proves the owner recorded a change; an agent's
  prose or a later message in the thread alone proves no disposition.
- Lifetime: the owner retains open work across agent runs and reconsiders it on
  upkeep; a stopped or stalled run is an attempt result.
- Old readers: the request still projects through the existing open/closed shape;
  no new stored field is required.

## Acceptance scenario

- **Seed:** Two open requests from different passages of one human message, plus
  a later human reply saying to keep working.
- **Action:** Try to withdraw either request with that reply, supersede one with
  the other, stop an agent attempt, and stall a forwarded continuation before
  its linking pass.
- **Expected:** Withdrawal and supersession are refused. Stop leaves the human
  request open. The stalled continuation is linked and remains eligible for
  recovery. One completed agent reply linked to two requests leaves both open
  until each is checked and closed separately. A later human message with exact withdrawal words addressed to the
  request can end it, and the Close control still withdraws its named requests.
- **Replayable offline:** yes, against a disposable owner ledger with marked
  human and agent inputs.
