---
failure: Claude refused a resumed conversation and Concierge held its exact request as if no Claude account had room.
date: 2026-11-21
fix_commits: []
cause_status: confirmed
---

# A Claude conversation refusal was reported as an account hold

## What was seen

The thread gardener's existing conversation refused the same original turn under two launch labels, both with the Sunday 10 PM Eastern reset of a third account. A new request on the exact Opus model succeeded. The request was handed off with its original custody and answered at 2:57 AM Eastern. Its provider-side quota owner remains unproved.

## Cause

The runner knew the launch credential, but the resumed Claude stream did not attest the account charged for the response. In-process fallback could record refusal against each selected account model. The cache rejected one of the mismatched reset writes, but the terminal error separately gave dispatch the reset as an account-wide wait. The request receipt then turned that wait into a claim about every account on the machine.

## Fix

The resumed stream keeps the refusal on the conversation. Only an independent fresh reading of the attempted account's applicable exhausted window can establish an allowance wait. A confirmed zero-work refusal can get one same-conversation retry against another account with room. A worked-on turn gets at most one service continuation for this refusal class. Its final failure returns through the original request without changing the Inbox binding or replaying a completed or uncertain effect.

## Acceptance scenario

- **Seed:** A pinned disposable Claude conversation, a launchable alternate account, and a fresh allowance reading showing room.
- **Action:** Deliver a terminal weekly-limit result to the Claude resume path. Exercise both a different reset and a matching reset for a window with room. Then repeat with an independently full window and with a fresh call.
- **Expected:** The resumed refusal with room does not write an account limit or provide a reset for the turn hold. The corroborated full window can give an allowance wait, and the fresh bound refusal still populates the exact account cache. One service continuation retains the originating input and cannot loop after a second conversation refusal.
- **Replayable offline:** Yes, through the disposable Inbox pin and account fixture.
