---
failure: Claude work held by a usage limit waited for the refusing account's own reset, days away, even after another Claude account had refilled.
date: 2026-10-10
fix_commits: [b9b57d16, 8ddc0d91, 0137284c]
cause_status: confirmed
---

# Held Claude work waited for the wrong account's reset

## What was seen

On the night of October 9, 15 queued inputs stayed stalled after the alternate Claude account regained room. A held
message told Tejas every Claude account was out until Oct 11 at 11 PM (tejas@chann.app's weekly reset) while
tejastej.dc@gmail.com refilled at 11:20 PM. The shared low-allowance warning also drifted to the later weekly reset.

## Cause

A Claude usage refusal set the hold's release time from the refusing account's reset, and fresh readings did not consult
the account chooser dispatch uses, so an account regaining room woke nothing. A live refusal also removed the saved
personal login from launch candidates (`bot/src/provider-start-choice.ts`), so it was not considered as a wait target.
Several places (holds, continuations, dispatch's all-spent reset, the notice, room lists) each computed "out until when"
separately.

## Fix

b9b57d16 keeps a refused account as a wait target while its login and refusal reset stay valid. 8ddc0d91 makes fresh
readings consult the dispatch chooser and wake only usage-held queued inputs (`provider-account-usage.ts`,
`provider-usage.ts`). 0137284c introduces one answer, `accountAvailability`, read by holds, continuations, dispatch, the
hold notice and room lists; peer-read accounts never count as room, and each reading moves held work earlier when an
account frees sooner.

## Acceptance scenario

- **Seed:** Two Claude accounts on this machine: A refused with a weekly reset two days out, B at its five-hour limit
  resetting in one hour; three inputs held.
- **Action:** A usage reading shows B with room.
- **Expected:** The held inputs are released to dispatch on B; before that, their hold reason states B's reset time,
  not A's.
- **Replayable offline:** yes (synthetic usage readings and a stub provider)
