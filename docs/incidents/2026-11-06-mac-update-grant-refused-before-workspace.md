---
failure: The authorized Mac update helper was refused before it could open Workspace.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Authorized Mac update helper refused before Workspace opened

## What was seen

The accepted Mac request named the exact thnkr.ing WebApp bundle and Sessions URL,
and asked to “Open Workspace once.” The pinned helper command matched the fixed
`open-workspace` form. PreToolUse refused it before execution. The app was not touched.

## Cause

The policy required the literal words “Workspace menu” in the accepted machine
need, although the recorded request said “Open Workspace once.” Independently,
the hook compared only the recorded need category with the environment category.
When both were `mac-app`, it could retain a refusal based on stale environment
data. If that environment had already admitted the command, the hook could skip
the current owner's source-bound record entirely.

## Fix

The menu intent accepts the recorded “Open Workspace” wording. Every native
update-helper attempt consults the current owner record and uses it for the
decision, including when the environment has the same category or would already
allow the command. An unavailable record refuses an action. Exact command, bundle,
URL, work scope and source provenance requirements remain.

## Acceptance scenario

- **Seed:** An accepted source-bound Mac work request names the exact bundle and
  Sessions URL with “Open Workspace once,” while the launch environment has a
  stale `mac-app` category.
- **Action:** Evaluate the fixed `open-workspace` command in PreToolUse.
- **Expected:** The hook uses the current owner record and admits the command;
  a missing or mismatched record refuses it. No helper process starts during
  this check.
- **Replayable offline:** yes (the policy and hook decision can use a synthetic
  owner response without contacting the app).
