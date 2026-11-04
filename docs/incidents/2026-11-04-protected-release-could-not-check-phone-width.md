---
failure: A protected Thinkering release could not complete its phone-width check.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Protected Thinkering release stopped before switching

## What was seen

Several sealed candidates refused the required phone-width check with
`SHIP_PHONE_PAGE_TOO_WIDE`. The checker actually exited at `unshare: Operation not
permitted`, before it could inspect any page. The live build stayed on its prior
revision. The existing report capture begins `13624dcf`.

## Cause

The machine's protected code launcher hid Concierge's live ledger in a Bubblewrap
mount namespace and dropped all capabilities. Thinkering's page checker needs a
private mount namespace and an overlay mount for a read-only view of real data.
Its first `unshare --mount` call was refused inside that sandbox.

## Fix

The launcher first hides the live ledger and its loop backing image in an outer mount
namespace. A second,
less privileged namespace inherits those locked mounts and has only the capabilities
needed for the page check's own mounts. Ordinary Concierge candidate checks keep
their existing capability drop. The security fixture checks that an attempted
unmount cannot reveal the ledger and that an overlay mount still works.

## Acceptance scenario

- **Seed:** A sealed Thinkering candidate and the installed protected code launcher, with the live Concierge ledger present.
- **Action:** Run the normal protected Thinkering release command through its phone-width step.
- **Expected:** The checker opens its read-only real-data view, checks every registered page, and the ledger remains inaccessible from the release process. A passing candidate can continue to its switch.
- **Replayable offline:** yes (the fixture checks the two namespace behaviors with a temporary overlay and the ledger hidden by the launcher; a full page check needs the server's real-data view).
