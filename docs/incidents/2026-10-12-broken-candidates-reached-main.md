---
failure: Commits that could not pass the release's own checks were pushed straight to main, and each one stopped Concierge updates until an autonomous repair fixed it.
date: 2026-10-12
fix_commits: [5d886a20, 1662d3d2, 2abf3654, de88b153, 4e5c283f, 2a36e1af]
cause_status: confirmed
---

# Candidates that failed their own checks stopped updates

## What was seen

Three updates failed in candidate preparation and needed autonomous repair:
- Incident 053dbab8 (October 10): the SQLite constructor gate could not parse `bot/src/request-protocol.ts`; new Brief
  guidance had two unescaped apostrophes inside a single-quoted string.
- October 12 (00:38): the composed foreground fixture still asserted two providers after the Accounts response gained
  Antigravity.
- Incident 33e99020 (October 12): 937b3b0d's card projection queried `session_inputs`, which the growth fixture's
  scratch database did not create.

## Cause

Commits reached `main` directly and were first checked by the installed builder after the push webhook. Syntax errors
and candidate-owned fixtures out of step with the code therefore surfaced only as failed updates on the server.

## Fix

5d886a20 escapes the apostrophes; 2abf3654 asserts the exact provider identities and supplies a null Google account;
1662d3d2 adds the missing tables and indexes to the scratch schemas. de88b153 runs the frozen build and presentation
candidate check on GitHub for proposed commits and makes `main` require it; 4e5c283f gives that worker its own scratch
state and 2a36e1af skips only the host-specific live-ledger probe there, which deployment still runs.

## Acceptance scenario

- **Seed:** A branch with a TypeScript syntax error in a scanned source file (and, separately, a projection that queries a
  table the fixture schema lacks).
- **Action:** Open a pull request and try to advance `main`.
- **Expected:** The required release check fails and `main` does not move; no update starts on the server.
- **Replayable offline:** partly (the candidate check runs locally; the branch rule needs GitHub)
