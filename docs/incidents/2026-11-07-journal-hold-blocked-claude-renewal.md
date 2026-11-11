---
failure: A journal hold covered Accounts and delayed an untouched Claude renewal for six hours.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Journal hold blocked Claude renewal before sign-in

## What was seen

At 01:16 UTC on November 7, Mac request `7ddea477-5e9f-49bd-87a9-2855aa7cfc07`
opened one Chrome task tab for the server Claude account
`tejastej.dc@gmail.com`. Thinkering showed **Journal to open today** over the
Settings page, so Accounts could not be reached. The Mac worker closed only its
task tab. It did not use the emergency opening, switch provider account, begin
Claude sign-in, or access a link or code. Its failed result is
`aca3ec6b-01c1-4ac8-901f-be897fff8d85`.

## Cause

The previous request `fac5ad17-22ca-4f9d-865d-04422caaa761` had failed even
earlier, before a task tab existed. The first repair gave that browser-control
failure one bounded retry. The second failure has a different cause: the browser
worked, but the accepted operational entrance was hidden by the journal hold.
The existing six-hour provider-failure hold would delay another attempt despite
no provider action having occurred.

## Fix

The worker now uses Thinkering's Accounts command above the journal hold. The
owner classifies a worker-attested entrance obstruction separately from browser
control and provider rejection, with one short retry per pre-authentication
failure kind. An open request or undelivered notice still prevents overlap.
Provider rejection still keeps the six-hour hold. The installed release and a
new Mac result are required to prove actual renewal and held-turn release.

## Acceptance scenario

- **Seed:** One signed-out server Claude account with a settled failed Mac request whose
result states that Journal to open today covered Accounts and that no sign-in
action, link, code or account switch occurred.
- **Action:** After two minutes, check the signed-out account again.
- **Expected:** Exactly one new notice and Mac request appear. While it is open,
further checks create none. A second entrance-blocked result holds for six hours.
A browser-control failure independently receives its one short retry. A provider
browser-verification refusal holds for six hours immediately. After a successful
worker sign-in, Accounts shows the exact server account ready and held turns resume.
- **Replayable offline:** The retry decision is replayable; Chrome sign-in and held
turn release require the live system.
