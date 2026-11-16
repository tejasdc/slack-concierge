---
failure: A browser-control failure before Claude sign-in held renewal for six hours.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Claude renewal stopped before sign-in

## What was seen

The automatic server renewal for `tejastej.dc@gmail.com` reached the Mac worker at
00:35 UTC. Chrome's active page changed during the first new-tab action, and the
separate browser connection was unavailable. Request
`fac5ad17-22ca-4f9d-865d-04422caaa761` settled failed. The worker confirmed
that it created no task tab, switched no account, and accessed no sign-in link or
code. The server account was still not ready.

## Cause

The renewal owner applied the six-hour failed-request hold to every failed Mac
request. That hold was added for Claude's browser-verification rejection, where
another immediate approval can make a provider check stricter. It also blocked
this failure even though authentication had not begun.

## Fix

The worker is asked to mark a pre-authentication browser-control failure with a
fixed result prefix and a no-action attestation. The owner classifies the
retained first failure by its complete no-action attestation, permits one
automatic retry after two minutes, and uses the existing six-hour hold after a
second such failure. An open request or undelivered notice still blocks retry.
Provider browser-verification refusals retain the six-hour hold.

## Acceptance scenario

- **Seed:** One failed renewal whose worker result attests that no task tab, sign-in link, code, or account switch occurred, and no renewal is open.
- **Action:** The periodic account check finds the same account still signed out after two minutes.
- **Expected:** One new repair notice starts one Mac request. A repeated browser-control failure then waits six hours. A provider browser-verification rejection waits six hours after its first failure. No two requests overlap.
- **Replayable offline:** yes (isolated renewal tables and request results can represent these states; production browser availability is separately observed).
