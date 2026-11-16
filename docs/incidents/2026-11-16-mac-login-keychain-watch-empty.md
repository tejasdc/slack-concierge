---
failure: The Mac's Claude credential watcher received no path from the login-keychain lookup and logged a startup error.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# The Mac's Claude Keychain watcher could not obtain a path

## What was seen

The Mac owner logged repeated `provider_auth_hold_watch_failed` events for
`claude-code` / `keychain_event` while discovering which file to watch.

## Cause

Read-only Mac command output confirms `security login-keychain -d user` exits 1 with no
path in the observed shell. The separate `default-keychain` command succeeds, but macOS
documents it as a different setting and it cannot safely stand in for the login-keychain
setting. The failed discovery only prevented file watching; it did not establish whether
Claude authentication succeeded or failed.

## Fix

Concierge now runs the login-keychain lookup asynchronously. When it returns no path,
Concierge watches the user's Keychains directory for keychain database changes, including
events whose filename is unavailable. Either listener only triggers the existing Claude
auth check; no Keychain secret is read by discovery. A path-free log records listener
registration.

## Acceptance scenario

- **Seed:** the login-keychain lookup exits nonzero without output while default-keychain returns a path.
- **Action:** start the Mac credential watcher, then resolve the lookup; separately stop it before resolving.
- **Expected:** the active watcher arms the directory listener, never substitutes default-keychain, treats an unknown changed filename as a possible Keychain event, and does not arm after stop. The live GUI owner emits the path-free armed log.
- **Replayable offline:** yes (lookup/registration lifecycle and event filtering; live GUI registration is a separate acceptance check)
