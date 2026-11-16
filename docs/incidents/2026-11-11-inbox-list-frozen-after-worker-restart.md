---
failure: After every presentation worker restart the Inbox list answered not-ready for two to five minutes.
date: 2026-11-11
fix_commits: []
cause_status: confirmed
---

# Inbox list frozen after each presentation worker restart

## What was seen

On November 11 the worker restarted at 04:48, 05:24 and 05:56 UTC for releases. After each start
its applied change position stayed fixed for two to five minutes while its progress counter climbed
and the ledger moved on by 1,000 to 3,400 changes. It kept the same generation, so this was not a
topic rebuild. An agent list probe at 05:57 answered not-ready on every first page, even after the
four-second catch-up wait.

## Cause

Receipt metadata records the digest of the installed worker bundle, so each release marks prepared
receipts stale. The first catch-up pass then rebuilt every historical receipt in bounded pages and
returned without applying any change, and nothing else advanced until that rebuild finished.

## Fix

The receipt rebuild now advances one slice of about 200 ms per catch-up pass, after which the pass
applies changes as usual. Applied changes update both receipt generations, and the replacement
activates at the shared applied position. The digest rule is unchanged, so a release that changes
receipt wording still refreshes every receipt without a version number to remember.

## Acceptance scenario

- **Seed:** A ready presentation database whose receipt digest differs from the running worker's.
- **Action:** Start the worker while the ledger keeps receiving changes.
- **Expected:** The applied position advances within seconds of start, while the receipt replacement
  completes later and activates without losing a change.
- **Replayable offline:** no; the check is a live worker restart with its health records.
