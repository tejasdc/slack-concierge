---
failure: Failed or cancelled agent attempts closed unfinished Inbox tasks without a guaranteed recovery attempt.
date: 2026-11-04
fix_commits: [b7fbfdda, 3ac5f463, d49be617, 605c3488, 02a61f6d]
cause_status: confirmed
---

# Failed agent attempts closed Inbox work

## What was seen

On November 4, Tejas learned that some requests in his Inbox had ended as failed.
The owner recorded a worker's failed or cancelled attempt in the thread, then closed
the associated Inbox request as `failed` or `withdrawn`. Ordinary threaded answers
do not wake the Inbox router. The upkeep flag covered uncertain endings, but was
one-shot: the router could consume it without producing a replacement dispatch.
These paths preserved the attempt's history while dropping the obligation to finish
the human task. This was a documented owner behavior, not a missing agent instruction.

During this investigation, a native Codex audit helper accidentally used its
parent's source pair to send a final completed reply for the whole repair request.
The helper had finished only the read-only audit. Its distinct Codex thread ID
was available in its environment while its session ID still named the parent.
The router command wrapper now refuses reply, outcome, cancel and topic-close
commands from such a helper; it still permits read-only inspection. The parent
reported the premature closure to the Inbox router and continued the repair.

The live audit found two further closure gaps after the first release. The Inbox
router sent Tejas's emphatic follow-up as an exact `--route-message` work request
but did not link that send to an Inbox request. Its provider later ended on a
capacity error; meanwhile the original task had closed on the audit helper's
overbroad completed reply. The router manually reopened the original task and
linked a continuation. New exact-message work sends now create or join a
request in the same transaction as the dispatch, locally and across the Mac
peer. A separate completed reply can honestly say `--not-checked`; that
qualifier now leaves the human task open for verification without replaying its
prior effect.

A later read-only live query found 35 exact-message work sends since October 1,
34 without any linked Inbox request. This is a third historical audit cohort,
separate from the 85 candidate request rows and 77 forwarded replies; the
cohorts may overlap and must not be added as distinct unfinished tasks. The
Inbox router received the exact request and source IDs for effect-aware
reconciliation before any historical action is repeated.

## Cause

The owner treated a terminal agent attempt as a terminal human task. Its one-shot
upkeep flag had no guarantee that a router turn produced another linked attempt.
The native audit helper later closed its parent's task because its inherited source
pair was accepted for a final reply.

The earlier paths each served a different purpose. A failed final reply preserved
the worker's answer in Tejas's thread; cancellation recorded that the particular
send would not continue; a hand-back returned a task to its asking agent when the
recipient was the wrong subject or too loaded. Thread upkeep was added to clear
stale open threads after work ended. None of those attempt-level outcomes proved
the human task was complete or transferred, and an ordinary threaded failure did
not wake the router to make that decision. The new boundary preserves their
receipts and delivery while keeping the human request alive.

## Fix

The owner retains the human task after failed, cancelled, stalled, handed-back or
unchecked attempts, and repeats a recovery input if a router turn ends without
progress. It also reads unfinished requests in closed threads and requires a
later answer as evidence when the router closes a human task without dispatching
another agent. The command wrapper refuses parent-task closure from native helpers.
His Close control withdraws the requests it names; the older human-closed threads
are reconciled the same way. An agent or owner closing a thread cannot withdraw
his work. Recovery counts attempts across replacement failures, so a loop does not
reset its delay or suppress the notice to him.

## Acceptance scenario

- **Seed:** An open human Inbox request is linked to an agent attempt that has ended as failed; no replacement attempt or live decision question exists.
- **Action:** Run Inbox upkeep, let the router's recovery turn end without linking a new attempt, then run upkeep after the recovery delay.
- **Expected:** The request remains open, and a second durable recovery input reaches the Inbox router with the original source and failed attempt; an audit helper cannot close its parent's request.
- **Replayable offline:** yes (using an isolated owner ledger and a simulated helper command environment).

## Scope of the diagnostic audit

A read-only SQLite diagnostic snapshot of the production ledger found 1,275 Inbox
request rows since October 1. The router's linked agent attempts include 1,451
answered, 139 failed, 92 waiting on a decision, 71 cancelled, 24 still open and
two undetermined. These are attempt counts, not distinct human tasks. Of 136
closed Inbox request rows labeled failed, withdrawn or superseded, 123 have a
direct human source or preceding human topic root. Ninety-one of those have a
latest terminal failed, cancelled or undetermined attempt and no completed
dispatch on that same request. Four of those 91 reflect explicit later human
Stop, withdrawal or supersession; two have separately verified recovery work.
The remaining 85 have no verified completion in the available ledger. This is
the conservative recovery set, not a claim that all 85 effects never happened:
each needs a prior-effect and later-work check before any external action.

The same snapshot contains six open stalled agent attempts; four link to open
Inbox requests and have no later completed request in their topic. Three
decision-needed agent requests had questions later expired because of a task
closure, requiring separate task-level review. Two genuine open requests reside
in a human-closed topic; the human closure explicitly said the two open requests
went with it, so they are not automatically reopened.

A second supported diagnostic snapshot on November 4 found 93 currently open Inbox
requests: 20 with no linked dispatch, 20 with a live attempt, 28 whose latest attempt
asked for a decision, 20 whose latest attempt answered, two failed and one cancelled.
Two of the open rows are in a thread Tejas explicitly closed; the repair records their
withdrawal from his Close action. The same snapshot found 77 human replies forwarded
to agents but not linked to any Inbox request: 63 answered, four failed, eight needing
a decision, one cancelled and one still open. They are a separate historical audit
cohort. The owner records the activation boundary for automatic new-reply tracking,
so installing this change does not manufacture 77 historical request rows before
their earlier effects are checked. The Inbox router received the exact retained IDs
for reconciliation. The complete explicit-reply query used only for recovery returned
688 rows in 0.54 seconds on that snapshot; normal list reads remain bounded.

## Repair invariant

An agent attempt may fail, stall, be cancelled or be handed back. The human
request remains open until an explicit completed result with a live check,
a live question only Tejas can answer, a proven replacement request, or Tejas's
later instruction to withdraw it. A completed agent reply that says a live check
was not possible leaves the human request open for verification without repeating
an acknowledged effect. An agent cannot turn its own failure into a final
human-task disposition. The owner records one durable recovery input per
request and repeat count, and repeats that input after the router turn ends without
linked progress, with a bounded delay. The router must inspect previous effects
before a new dispatch. A missing source link triggers provenance investigation
instead of silent omission or an invented human instruction.

## Evidence boundary

The candidate audit was read-only. Source/build checks alone do not prove the
installed owner or a user's visible Inbox behavior. Review, merge, installation,
marked test requests and historical reopens are recorded as separate evidence
when they occur.
