---
failure: Every Claude session on the Mac was held as "This account could not sign in" from Nov 10, while all three Claude logins on the Mac still worked.
date: 2026-11-11
fix_commits: []
cause_status: confirmed
---

# Mac Claude work held as signed out while every login worked

## What was seen

From the evening of Nov 10 2026 every Claude turn on the Mac's Concierge was retried every three
minutes and held with "Not logged in: no Claude account on this machine has a working sign-in of
its own". The Inbox showed "This account could not sign in". At the same moment the Mac's own
activation probe passed ("works", every 3 minutes), the usage reader read all three accounts with
no problem, both own-login renewals at 03:17 and 03:18 UTC on Nov 12 succeeded, and Tejas's own
`claude` in Terminal worked. A repair agent checking over SSH saw `claude auth status` say
`loggedIn: false` for every home; that was the SSH session's locked login Keychain ("User
interaction is not allowed"), not the logins.

## Cause

Dispatch launches an extra Claude account only from a home that links every shared entry of
`~/.claude`. The Mac's `~/.claude` holds `stats-cache.json`, Claude Code's statistics cache, which
Claude rewrites as a new file whenever it runs in a home, replacing the link with a private copy.
The file was not classed as scratch, so each home read as incomplete
(`claude_account_home_incomplete ... missing: ["stats-cache.json"]`) from the first time Claude ran
there: hey@tejas.nyc on Nov 6, tejas@chann.app on Nov 8, tejastej.dc@gmail.com on Nov 10. When the
last one went, no home was launchable and dispatch threw its sign-in refusal. The server has no
`stats-cache.json` in its main folder, so it never tripped there.

## Fix

`stats-cache.json` is scratch: shared when possible, a private copy accepted and never moved. The
per-login and scratch lists now live once in `bot/src/claude-home-entries.ts`, read by both the
owner's account homes and runner account homes, instead of two copies.

## Acceptance scenario

- **Seed:** a main Claude folder containing `stats-cache.json` and settings; an extra account home
  with its own login, links to every shared entry except a private regular `stats-cache.json`.
- **Action:** dispatch chooses a Claude account for a queued turn.
- **Expected:** the home counts as complete and the turn launches from it; no
  `claude_account_home_incomplete` line names `stats-cache.json`.
- **Replayable offline:** yes (temporary home folders and a `.credentials.json` login file).
