---
failure: A pre-host native Claude UUID had no saved or launched machine-home evidence; the new fail-closed guard refused both November 17 starts.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# Native events conversation had no provable machine home

## What was seen

On November 17, 2026, Concierge advertised a native Claude conversation as active, then
refused agent work because its exact machine home could not be established. The owner ledger
shows this was a failed start: the two November 17 attempts failed before provider start or
acknowledgement. The 12:32 request was routed to a fresh session; this repair does not replay
either earlier request.

## Cause

The retained native transcript for the conversation is byte-identical to its archived
copy (536,140 bytes, 87 rows, SHA-256
`cfa3c31f707ea158fe4b24d25e006cce60e748f3b2f868784fc888f15bb7daf8`), with its last
provider activity on September 26. The conversation already had its native UUID before
hosted execution custody was introduced. First-turn machine binding persistence was added
later and applied only when no native UUID existed. The November 5 fail-closed guard then
refused existing UUIDs without saved binding or exact launched-execution evidence.

The read-only owner-ledger snapshot confirms no saved provider home and zero execution rows.
It contains three turns: one successful, acknowledged September 26 turn, and two November 17
failed starts before provider start or acknowledgement. There is no evidence that a previously
saved binding was deleted. The mechanism is a pre-host/pre-binding conversation that later met
the fail-closed guard without any durable machine-home evidence.

## Fix

Native Claude execution selection and agent admission now share a fail-closed home resolver.
An unknown home is visible in agent search and does not disable the human composer. Confirmed
dispatch pins a known legacy execution home. An authorized, source-bound `sessions repair-home`
control can recover an idle unbound UUID only after the selected machine resolves the registered
project and proves the exact transcript and Claude account. It rechecks authority and target
state before saving; it never replays conversation input or changes the provider UUID.

## Acceptance scenario

- **Seed:** A native Claude UUID has no saved provider home or launched execution, alongside
  fixtures for launched, locally bound, runner-bound and imported conversations.
- **Action:** Run the home resolver and source-bound `repair-home` command fixture with controlled
  runner project, transcript, account, availability and concurrent target-state outcomes.
- **Expected:** The unknown session is not agent-messageable while its human composer remains
  available; existing executions and explicit local bindings retain priority. Recovery records
  exact evidence and saves only after authority, lifecycle, identity, generation and idle checks.
  Missing, ambiguous, unreachable and changed-state candidates leave binding untouched; duplicate
  actions preserve the first terminal result. Retrying a pending action after the target UUID or
  binding generation changes conflicts with its retained target identity. Imported consultation
  remains unchanged.
- **Replayable offline:** yes
