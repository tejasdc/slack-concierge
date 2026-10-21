---
failure: The Mac's Concierge crash-looped from about 3 AM on October 10 because a cached compiled copy of its code made the owner think it was a read worker.
date: 2026-10-10
fix_commits: [fad0d77e]
cause_status: confirmed
---

# The Mac owner crash-looped with INBOX_NOT_READY

## What was seen

From 02:52 ET on October 10 the Mac's Concierge failed every start with `INBOX_NOT_READY`; Mac sessions and the peer were
unavailable until the fix installed.

## Cause

The Mac runs source with Bun in several processes with different environments. Bun's runtime transpiler cache is keyed
by file contents, but its compiled copy of `session-owner.ts` had every `CONCIERGE_READ_WORKER` comparison folded to
true: it was compiled inside a read worker and then served to the owner. Starts with the cache disabled ran normally;
with it enabled they failed. Sealed server bundles are unaffected.

## Fix

fad0d77e sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` in the Concierge and speech launchd plists
(`launchd/com.tejasdc.concierge.plist`, `com.tejasdc.concierge-speech.plist`), inherited by every child, and records the
rule in AGENTS.md and the peer runbook.

## Acceptance scenario

- **Seed:** A Mac-style source install with a read worker started first (populating any transpiler cache) under its
  environment.
- **Action:** Start the owner from the same source under the installed launchd environment.
- **Expected:** The owner starts and its Inbox becomes ready; no cache directory is written.
- **Replayable offline:** yes on any Bun host with the same Bun version (macOS not required to reproduce the cache fold)
