---
failure: A new Mac session refused for Claude usage closed its request as failed instead of moving the work to another account or holding it.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# The app-blocker request on the Mac failed the moment one Claude account ran out

## What was seen

At 18:28 UTC the Inbox router sent the iPhone app-blocker build to a new Mac session
(mac:246, request `6e87657b`). Within four seconds the request settled `failed` with "Claude usage
is exhausted on tejastej.dc@gmail.com … Concierge sends the work to another Claude account with
room". Nothing was moved from the requester's point of view. On the Mac, the work was in fact
still queued: a continuation (turn 1121) ran on tejas@chann.app, was refused because that
account's Mac sign-in had expired, and its own continuation (turn 1122) sat held for a sign-in.

## Cause

Three faults in a row.

1. Claude Code writes its usage-limit notice as an assistant row with the model `<synthetic>`.
   Concierge counted that row as the agent having worked, so a turn that had done nothing took the
   worked-on path (fail the turn, queue a continuation) instead of the zero-work path (retry the
   same input on another account, or hold it).
2. Claude's in-process model fallbacks (Opus, Sonnet, Haiku on the same account) each reset the
   remembered reset time; Haiku's refusal named none, so the final refusal carried no reset and
   could not have been held either.
3. The Mac reported the request's progress to the cloud from the first refused turn only. The
   cloud saw an input in state `failed` and settled the request, although the server's own
   request path already follows a refused turn's continuation chain and keeps such a request open.

Separately, and not a code fault: the Mac's tejas@chann.app Claude login has expired, and its
other account had spent its week, so on the Mac no Claude account could run the work.

## Fix

`<synthetic>` rows are not agent output (`ClaudeOutputAccumulator`, and the live message
`providerNotice` mark read by `turn-execution.ts`); the account's first stated reset survives
model fallbacks; `carryingTurn` in `session-inputs.ts` is the one continuation-chain reader for the
server's request settlement and the Mac's peer status, which now reports the carrying turn's state
and hold. The usage-refusal text now says what happens: the work moves to an account on this
machine that can take it, or waits for the first reset or sign-in.

## Acceptance scenario

- **Seed:** a Mac peer with two Claude account homes: one at its weekly limit, the other signed out.
- **Action:** the cloud asks a new Mac session for work; Claude refuses the first account for usage.
- **Expected:** the request stays open on the cloud; the Mac's turn is held (sign-in or reset) with
  its original input, and the requester is told it is held; signing the other account in runs it.
- **Replayable offline:** no (needs a real Claude usage refusal on a Mac peer)
