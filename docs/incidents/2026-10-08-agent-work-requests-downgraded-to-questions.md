---
failure: Agents sent build work by another agent treated it as a question and came back with designs instead of building, and the resend was refused.
date: 2026-10-08
fix_commits: [831e9a9d]
cause_status: confirmed
---

# Work handed between agents arrived as information only

## What was seen

The lab coordinator, working on something Tejas asked for, sent build requests to three agents. All three came
back with designs but nothing built, answering in effect "re-send this as Tejas's own message". The
coordinator's resend as work was refused.

## Cause

Confirmed from 831e9a9d. In `session-communication.ts` a request without `--requested-effect` was recorded as
informational. Separately, the sender's authority was judged only from the input that opened the sender's
current run: a planner's question had opened the run in which Tejas was talking to the coordinator, so the run
counted as information-only and could not send work, even though it also held his task.

## Fix

831e9a9d: `authority(actor)` judges authority over the sender's whole run, carrying the request on the run's
earliest human or agent input that holds work authority; a run holding only questions stays information-only.
An unmarked request inherits that scope, unless the sender is a writing session or the target cannot receive
work (`receivesWork`: ChatGPT, consultation-only, unsendable imports). The per-run instructions in
`session-input-context.ts` and ROUTER-ACTIONS.md now say a request carries the sender's authority by default
and `--requested-effect informational` narrows it.

## Acceptance scenario

- **Seed:** session A with a run opened by an agent's informational question, into which Tejas's work message
  was then steered.
- **Action:** A runs `sessions ask` to session B with no `--requested-effect`.
- **Expected:** the request is recorded as work, citing Tejas's input as authority; B's instructions present it
  as work. A run holding only questions still produces an informational request and cannot send
  `--requested-effect work`.
- **Replayable offline:** yes (scratch ledger, router helper against a scratch owner)
