---
failure: An agent handling Tejas's explicit account-switch request had no attributed entrance to the guarded Codex switch.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Agent could not switch saved Codex account

## What was seen

Tejas asked the account agent to move Codex on his server and Mac to `tejas@chann.app`. The server held a saved login for that account, but its access token had expired, so CodexBar returned HTTP 401 and omitted it from the usage list. Codex's own `account/read` with token refresh renewed it; the subsequent direct reading showed 0% weekly use and no extra credits. The Accounts screen had a guarded switch, but the agent's session command surface had none. Calling the human Accounts entrance from an agent would record the wrong actor.

## Cause

The guarded Codex switch existed only behind the human Accounts route. Session communication could attribute requests, replies and other agent actions but could not invoke this switch under an exact source input, run and action ID. The saved account's expired access token independently prevented its usage reader from seeing current room until Codex renewed it.

## Fix

The agent command enters the existing guarded switch with the source pair and an idempotent receipt. The account move, App Server restart, authentication proof, rollback and running-turn refusal remain in their existing owner operation. A duplicate after an unconfirmed result is reported uncertain rather than repeated. When the separate usage reader sees an expired saved access token, it asks Codex's own App Server in that home to renew the login, then takes a fresh usage reading. The reader neither copies nor rewrites credentials and never treats the old reading as room. Renewal and switching exclude one another across the machine so a token rotation cannot race either side of the credential move. Codex's explicit revoked-token refusal enters the existing sign-in repair; a transport failure does not assert sign-out.

## Acceptance scenario

- **Seed:** a work-authorized agent run, a saved Codex login, and no running Codex turn on the chosen machine.
- **Action:** the agent names that saved profile and machine with a stable action ID.
- **Expected:** the guarded switch proves the running Codex identity and retains an agent-authored receipt; a duplicate action cannot move credentials again. An information-only run or a machine with active Codex work cannot switch.
- **Renewal:** if the saved access token expires, the usage reader asks Codex to refresh that same home and reads the allowance again without a sign-in request to Tejas.
- **Replayable offline:** partly; authorization and duplicate receipt can be checked with a scratch owner, but a real account proves the App Server identity.
