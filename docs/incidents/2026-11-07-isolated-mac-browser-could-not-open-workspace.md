---
failure: The isolated Mac browser opened thnkr.ing Settings without a workspace identity.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Isolated Mac browser could not open the workspace

## What was seen

An accepted headless Mac fallback opened `https://thnkr.ing/settings` in its own profile.
The page said local storage was unavailable and would not open the workspace. A live
follow-up directly wrote, read and removed a localStorage key and an IndexedDB database
successfully, while workspace API reads returned 401 `AUTH_REQUIRED`. The page's storage
sentence is the generic startup-failure text, not a direct storage result.

## Cause

The fallback intentionally uses an empty, request-specific browser profile and has no
Tejas secure-session cookie. Its launcher supplied no agent-owned page identity, so normal
workspace routes refused the page before Settings could load.

## Fix

For thnkr.ing only, the admitted Mac launcher asks the server's private capability socket
for a short-lived read ticket bound to its accepted input and run, attaches it to the
recorded origin, and clears the ticket file after opening. thnkr.ing checks that ticket
for page reads and refuses human-attributed writes.

## Acceptance scenario

- **Seed:** An accepted Mac browser fallback for `https://thnkr.ing/settings` with a
  recorded failed server attempt, and no Tejas browser cookie.
- **Action:** Open Settings through the isolated Mac launcher and inspect the page.
- **Expected:** The workspace and Accounts page load with read API requests succeeding;
  a write such as Accounts Refresh is refused without a separate agent-attributed command;
  no personal Chrome window opens, and the private profile closes afterward.
- **Replayable offline:** no (source-bound grant and installed Mac browser require the
  live owners and thnkr.ing service).
