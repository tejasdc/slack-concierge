---
failure: When one Claude account hit its limit while the other had room, some agents' work was dropped and their requests closed as failed, and the rest waited for the spent account's reset.
date: 2026-10-08
fix_commits: [8a922150, 5974c285]
cause_status: confirmed
---

# One Claude account's limit dropped and held work while another had room

## What was seen

At 2:54 AM on 2026-10-08 six turns were refused on tejas@chann.app while tejastej.dc@gmail.com had room. They
first waited ~40 s for chann.app's reset. Three were then continued; three were not, and the requests they
served (including a lab agent's) settled failed. Even continued work lost its request: the reply from the
continuation was refused as "already settled". The refusal text promised the input "keeps its place and is
tried again" before anything had been decided. This was the third recurrence of usage-limit work loss.

## Cause

Confirmed from both commits.
- `turn-execution.ts` skipped a continuation whenever the session already had newer input queued (often another
  requester's steer), even when the turn ended on a provider refusal.
- `session-communication.ts` settled the served request failed as soon as the refused turn ended, ignoring a
  pending continuation.
- The move-away decision read the session's last recorded account (`sessionMetadata.claudeAccount`), written
  only once Claude reports a start, so it could name an earlier attempt's account (5974c285).
- gmail had no saved proof in the new proof table and accounts were proved only at the moment work needed one,
  so the hold waited for the check.

## Fix

- 8a922150: a worked-on usage/rate/sign-in refusal is always continued, regardless of newer input; the request
  stays open while any continuation in its chain is running (follows the chain); `claudeAccountWithRoomBesides`
  uses the dispatcher's own rule so the continuation runs immediately with no "waiting until reset" notice when
  another account has room; refusal text names the account. Reviewed by GPT-6 Astra (SHIP on third verdict).
- 5974c285: every complete account home without proof is checked in the background on each usage reading; the
  move decision uses the account the attempt actually ran on (`runningClaudeAccount`).

## Acceptance scenario

- **Seed:** two Claude homes, A at its limit and B proven with room; a session running a worked-on turn on A
  for request R, with another requester's input queued behind it.
- **Action:** the provider refuses the turn for usage on A.
- **Expected:** a continuation runs on B at once; R stays open and settles from the continuation's final reply;
  no wait-for-reset notice; refusal text names A.
- **Replayable offline:** no (needs a real provider usage refusal, or a stubbed provider adapter)
