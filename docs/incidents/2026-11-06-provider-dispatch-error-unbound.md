---
failure: A retryable provider dispatch refusal became an unexpected runtime error before a request could start.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# A provider dispatch refusal lost its retry classification

## What was seen

After the Codex account switch, the installed owner logged repeated `ReferenceError: ProviderDispatchError is not defined` errors while trying to admit provider turns. The affected turns had not started at a provider. The ordinary account reading subsequently released the Inbox's usage hold and its oldest turn started, but the runtime error remained a separate failure path for unreadable or mismatched runner accounts.

## Cause

The turn executor constructed a retryable provider dispatch error in its runner account checks without importing that error class. Bundling succeeds without type checking this unresolved runtime name, so the installed release was able to reach the broken branch.

## Fix

Import the existing dispatch error class used by those checks. An unavailable or unverified runner account again produces the typed retryable hold, preserving the unsent turn for a later account reading.

## Acceptance scenario

- **Seed:** A provider runner account reading is missing or its identity check fails before provider admission.
- **Action:** Admit the saved turn.
- **Expected:** The turn receives a retryable account-reading hold, rather than a runtime reference error; it remains available to resume when the account reading recovers.
- **Replayable offline:** yes, with a runner identity refusal; installed behavior needs a live provider outage to exercise the same branch.
