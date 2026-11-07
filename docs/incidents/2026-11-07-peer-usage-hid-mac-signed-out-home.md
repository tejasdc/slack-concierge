---
failure: A server usage reading made a signed-out Mac Claude home appear signed in.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Peer usage hid a Mac sign-out

## What was seen

After the Mac installed the usage reader, Claude Code reported the saved Gmail home signed out. Its Accounts response still marked that profile signed in and displayed a weekly usage bar. The bar was explicitly sourced from the server, while two other homes had fresh Mac-local source times.

## Cause

The Mac reader recorded the Gmail home's signed-out state. The subsequent peer merge chose the server's newer usage observation for the same label and replaced the whole account row, losing the Mac's sign-in verdict. The saved Keychain item's presence had only established that a credential existed, so the Accounts view had no remaining reason to mark the profile signed out. The selected-home dispatch exception also lacked a check against a signed-out usage row.

## Fix

Peer merging chooses the freshest usage windows and source time while retaining this machine's sign-in verdict. Dispatch rejects an explicitly signed-out home before considering the selected-home exception. A peer reading can fill a bar but cannot turn a local home into a signed-in profile or authorize a turn there.

## Acceptance scenario

- **Seed:** A Mac home with a present Keychain item whose own Claude auth status is signed out, and a newer server usage reading for the same account label.
- **Action:** Refresh the Mac Accounts view.
- **Expected:** The Mac profile says signed out and offers sign-in again. The usage bar, if shown, retains its server source and original source time; the Mac home is not treated as runnable.
- **Replayable offline:** yes (the local and peer observations can be seeded without credentials).
