---
failure: A Claude login whose access token had just expired was read as signed out and a browser renewal went to his Mac.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Expired access token read as signed out

## What was seen

At 03:22:01 UTC on November 13 the owner recorded a sign-in renewal for
`tejastej.dc@gmail.com` ("its sign-in on runner ax41 stopped working") and sent the
Mac browser agent request `7b4b55a1-e858-49a5-8614-b5a86cd2981c` at 03:22:56. The
repair agent (`concierge:8898`) found the account's runner credentials had an access
token expiring at 03:18:41 UTC, a refresh token valid until 2026-12-05 and no ended
login; a live Claude Code request from that home answered at about 03:23.

## Cause

The runner's Claude reading lists accounts through claude-swap 0.26.0. Its
`token_expired` usage status is defined in its own source (`json_output.usage_fields`)
as "active token expired and the refresh was deferred this pass ... retried
automatically". The runner fell back to reading usage with the stored access token,
which had expired, and then marked the account signed out for either
`token_expired` or `relogin_required`. The owner's reader showed the same status as
"This account needs signing in again."

## Fix

Only `relogin_required` marks a Claude account signed out; `token_expired` keeps the
last reading with its ordinary could-not-read note. A dead refresh token still reports
`relogin_required`, and a refused turn still raises a renewal through its own path.

## Acceptance scenario

- **Seed:** A runner Claude home whose access token expired minutes ago, refresh token
valid, and claude-swap reporting `token_expired` for it.
- **Action:** The runner's next usage reading.
- **Expected:** The account is not signed out and no renewal notice or Mac request is
recorded; with `relogin_required` it is signed out and one renewal follows the hold rules.
- **Replayable offline:** Yes, with a stubbed claude-swap list.
