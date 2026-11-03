---
failure: Concierge's Mac browser guard refused its own provider sign-in renewal before the worker could open Accounts.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# Provider renewal blocked before the browser opened

## What was seen

The Mac worker received Concierge's request to renew Claude for hey@tejas.nyc on
the Mac through thnkr.ing Accounts. Its first Computer Use documentation call was
refused by the PreToolUse guard. No browser action or sign-in occurred. The
request remained open. The Mac ledger retained an outside `signin-renewal`
request and a matching Claude sign-in repair notice.

## Cause

The November 3 guard required a desktop-capable Mac need and categorically
refused Computer Use aimed at Chrome. The owner-generated provider renewal had
no machine need attached. The general website restriction was applied to the
specific provider renewal Tejas had authorized on October 8
[decision: provider-accounts-switch-automatically].

## Fix

The Mac owner recognizes its own outstanding sign-in repair request, including
the return that resumes the worker after a child request. Server-origin repair
requests carry a need that the Mac accepts only from a service repair notice
addressed to the existing worker. The tool guard admits Computer Use with Chrome
only while that need is current. Ordinary agent requests cannot claim it, and
the general website guard and isolated fallback are unchanged.

## Acceptance scenario

- **Seed:** An outstanding Mac provider sign-in repair request with matching
  repair notice; a later child-request answer returns to its worker. Also seed
  an ordinary Mac website request.
- **Action:** The worker starts Computer Use and opens the saved Chrome session
  for thnkr.ing Accounts; the ordinary agent attempts the same tool.
- **Expected:** The worker's call is admitted through the owner-recorded repair
  request and the ordinary call remains refused. The renewal can complete, and
  Accounts then shows the requested provider account signed in.
- **Replayable offline:** partly (the admission check runs offline; provider
  sign-in requires the real Mac browser and Accounts).
