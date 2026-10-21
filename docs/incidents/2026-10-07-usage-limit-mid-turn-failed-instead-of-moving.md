---
failure: When the selected Claude account hit its limit mid-turn, agent turns failed instead of moving to the other account that had room.
date: 2026-10-07
fix_commits: [7872f111]
cause_status: confirmed
---

# Agent turns failed on a full Claude account while the other account had room

## What was seen

At 9:02 PM EDT on 2026-10-07 the selected Claude account (gmail) hit its five-hour limit while chann.app had
room. Agent turns failed with a plain error ("429 ... model not changed") instead of moving to chann.app or
waiting for the reset. After the 8:43 PM restart chann.app's account check also took two minutes, so work
kept failing on the full account meanwhile.

## Cause

Confirmed from the commit and diff, two parts:

- In `runClaudeCodeTurn` (`bot/src/claude-code.ts`), a usage refusal triggers a fallback-model switch on the
  same account. Claude refused that too, and the `modelSwitchError` path threw a generic `ProviderDispatchError`
  without a usage classification, so dispatch saw an ordinary failure rather than an exhausted account and
  never chose another account.
- Which account homes were proven to do work (`provenHomes` in `bot/src/provider-account-dispatch.ts`) lived
  only in memory, so each restart forgot it and `provenOrProve` had to re-run the two-minute
  `claudeAccountWorks` check before chann.app was eligible.

## Fix

7872f111: a failed model switch is reported as usage exhaustion (`failureClass: "parked_terminal"`, with
`clearsAtMs` when a reset time is known), so the turn moves to an account with room or waits for the reset.
Proof is stored in a new `claude_home_proof` ledger table (`provider-account-selection.ts`) that survives
restarts; a refusal, a new login or an explicit switch still withdraws it.

## Acceptance scenario

- **Seed:** two Claude account homes, both proven; the selected one returns a usage refusal and then refuses
  the fallback model switch with a 429; the other has room. Restart the owner once before dispatch.
- **Action:** dispatch an agent turn.
- **Expected:** the turn is classified as usage-exhausted (not a plain failure) and runs on the account with
  room without a new two-minute check; with no account having room it waits until the stated reset.
- **Replayable offline:** yes (fake Claude provider emitting the refusal sequence; scratch ledger)
