---
failure: A fresh Claude Code reviewer launched inside the private code entrance waited 75 seconds and blamed an unresponsive Concierge.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Claude launch waited for a Concierge the private code entrance hides

## What was seen

Two reviewer launches for the Blyg Reader draft repair each waited about 75 seconds and
reported that Concierge did not answer and nothing was sent. Concierge stayed healthy and
answered other account-choice requests in 2-3 ms throughout.

## Cause

The launcher asks Concierge which Claude account to use over the socket beside its state
directory. The private code entrance gives each command fresh scratch state and hides the
live Concierge directories, so that socket does not exist there. The request client treated
the missing socket as a restart and retried for its whole 75-second window. Reproduced on
2026-11-04 by running the installed `claude` wrapper through the installed private code
entrance: it failed after 80 s with the same message, while the same command outside it
reached Claude in 25 s.

## Fix

The private code entrance names its scratch state, and the request client refuses at once
when its state is that scratch directory, saying Concierge is hidden on purpose and that
Concierge commands and fresh Claude launches belong in the ordinary shell. Checks that start
their own owner under a different state directory still wait for it.

## Acceptance scenario

- **Seed:** The installed private code entrance and `claude` wrapper.
- **Action:** Run a fresh Claude command through the private code entrance, then the same command from the ordinary shell.
- **Expected:** Inside, it stops within a few seconds with the private-entrance explanation; outside, it reaches Claude on the account Concierge chose.
- **Replayable offline:** yes (the inside refusal needs no credentials; the outside launch needs an account with room).
