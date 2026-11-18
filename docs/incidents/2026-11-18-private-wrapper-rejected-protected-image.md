---
failure: The protected code launcher refused to start harmless checks after recognizing its already protected ledger image as the wrong file type.
date: 2026-11-18
fix_commits: []
cause_status: confirmed
---

# Protected code checks stopped before their child launched

## What was seen

Request `8b6dde23-1c70-4422-9011-a6a9748b7e16` reported the installed private code
launcher failing before starting a check. A harmless `true` child reproduced the same failure
in an agent namespace that retained the ledger loop mount and correctly denied opening its
backing image. The actual application ship had already succeeded directly and was not replayed.

## Cause

Loop discovery required the backing path to remain a regular file. The agent boundary correctly
replaced that path with the inaccessible 0:0 character device, so discovery rejected the intended
protection before applying the private launcher's full directory masks.

## Fix

Reuse the image boundary's one exact inaccessible-device predicate. Accept a regular backing
file or that existing mask and keep its path in the hide set. Reject directories and other
character devices. Do not return early just because the image is masked: the canonical and
actual store directories still need protection. Preserve inherited-null builder compatibility.

## Acceptance scenario

- **Seed:** A namespace retaining the store loop mount with its backing image already masked
  by the inaccessible 0:0 device, and the canonical and actual store directories still visible.
- **Action:** Start a harmless child through the source/bundled private launcher and both
  capability modes, then perform no-byte image-open and directory-mask metadata probes.
- **Expected:** Child starts, image open fails, both store directories remain mode 000 and
  unreadable or empty. Regular scratch backing paths remain accepted, other nonfiles fail,
  and the preceding builder's inherited-null preparation still starts a harmless child.
- **Replayable offline:** yes (owned scratch discovery/mask/bundle regression); reproducing
  the original live topology additionally needs its existing masked loop-mounted namespace.
