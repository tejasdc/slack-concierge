# Monologue delivery receipts

## Goal

Close the existing Monologue crash window between posting a transcript to Slack
and recording the source file as seen, without changing its working user-facing
flow or coupling it to Pebble capture.

## Candidate approach

- Persist a stable source identity and posting intent before the Slack call.
- Record the returned Slack timestamp before updating the seen-file projection.
- On restart, reconcile only unresolved intents and use stable identities to
  avoid reposting a message already known to Slack.
- Keep the current timer, source files, user-authored Slack behavior, and
  destination unless a later migration has its own reviewed benefit.

## Why it is separate

This is a real reliability improvement, but Pebble neither causes nor fixes the
Monologue post-before-seen window.

The complete exploratory mechanics and threat analysis remain in
`2026-08-19-platform-hardening-source-design.md`.
