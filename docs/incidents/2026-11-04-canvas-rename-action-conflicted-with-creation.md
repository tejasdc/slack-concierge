---
failure: A Canvas rename could not update its project choice while Sessions was open.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# A renamed Canvas kept its old name in project choices

## What was seen

In a marked browser check, Sessions stayed open while another browser renamed a Canvas. The project choice still showed the old Canvas title. The rename request received a conflict response.

## Cause

The browser reused the folder creation action identity for a later title revision. The command gateway correctly refused the new body as a conflicting replay. The project owner also required that original action identity on every later update.

## Fix

The browser gives each title revision its own action identity. The project owner keeps the first folder choice bound to the Canvas ID and accepts a different action identity for a later title, applying only a newer revision clock.

## Acceptance scenario

- **Seed:** A Canvas has a generated project and Sessions is open on another device.
- **Action:** Rename the Canvas while Sessions stays open.
- **Expected:** The project choice changes to the new title beside the same folder; replaying an older revision leaves the new title in place.
- **Replayable offline:** yes (the marked agent workspace owner and two browser contexts reproduce the exchange).
