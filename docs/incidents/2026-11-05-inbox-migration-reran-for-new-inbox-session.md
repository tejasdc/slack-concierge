---
failure: When a new Inbox session appeared, Concierge redid the one-time Inbox conversion at startup, delaying its request entrance by 31 seconds and reopening old threads as phantom requests.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Inbox conversion reran for a new Inbox session

## What was seen

The owner start at 11:33 UTC on 2026-11-05 logged the Inbox topics migration step at
30,772 ms, 164,490 ledger calls and 29,988 ms of ledger occupancy, for Inbox session
8785. It walked 3,610 historical thread roots and created 948 recovered topics, each
with an open request. The request entrance answered at about 57 seconds, inside the
90-second health deadline. Every later start that day logged the step at 0 to 5 ms.

## Cause

The one-time conversion of the legacy Inbox into topics was guarded by its completion
event on the current Inbox session only. The current Inbox is the newest session marked
as the Inbox, so a provider or folder cutover that makes a new Inbox session looked like
an Inbox that had never been converted. The migration then rebuilt the whole entry index
synchronously in startup and made topics for every eligible root that the live router had
deliberately left without one, which is why recovered service returns and upkeep later
needed their own cleanup (`docs/contracts/native-inbox.md`, bookkeeping repair).

## Fix

The conversion, and the attention conversion version 2, are done once any Inbox session
carries their completion event. A new Inbox session has no legacy backlog: everything after
the first conversion is filed live. A fresh installation with no completion event still
runs the conversion once. Moving the work after startup was rejected because the work
itself was wrong to repeat, not only badly placed.

## Acceptance scenario

- **Seed:** A ledger whose first Inbox session has completed the topics and attention migrations, with recovered and live topics.
- **Action:** A second session marked as the Inbox is created, and the startup migrations run.
- **Expected:** Both migrations report already migrated; no topic or request is created.
- **Replayable offline:** yes (`bot/scripts/inbox-bookkeeping-recovery-fixture.ts`).
