---
failure: A held message's prepared receipt omitted its retained attachments, so an observer could show the text but not the file.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Held receipt omitted attachments

## What was seen

A fresh public agent-attributed upload and ordered Send reached a dedicated paused
session. The owner retained the exact bytes, source pair and attachment ID, and the
already-open thnkr.ing observer showed the held message text. It did not show the
attachment name, preview or file actions.

## Cause

The canonical operation retained the attachment custody IDs, while the prepared
receipt used by the observer projected only message and execution state. It did not
publish the immutable attachment metadata needed to render a file. The client could
not recover that metadata from a receipt window without issuing one operation-detail
read for every rendered row.

## Fix

Exact operation receipts now carry the accepted input's exhaustive ordered attachment
descriptors: custody ID, name, media type and SHA-256 hash. Bounded prepared cards
carry the largest ordered prefix that fits plus explicit complete/count coverage; the
existing exact-detail reference owns a rare overflow. The accepted request continues
to retain the original ID array, and bytes plus source attribution remain behind the
authenticated attachment read. A projection rebuild gives already-held receipts the
same descriptors and coverage as new ones.

## Acceptance scenario

- **Seed:** Retain one ordinary attachment and a second input with twenty long-named attachments, then hold both inputs in a paused session.
- **Action:** Read the exact operation receipt, a rebuilt prepared receipt window, and a later prepared change page.
- **Expected:** The ordinary receipt paths carry the same ordered attachment ID, name, media type and SHA-256 hash with complete coverage. The crowded exact receipt remains exhaustive; its prepared card stays below its byte bound, carries a useful ordered prefix and declares incomplete coverage with the full count. The immutable request still contains only the original ID array, and no provider run is admitted.
- **Replayable offline:** yes, against disposable canonical and prepared receipt databases.
