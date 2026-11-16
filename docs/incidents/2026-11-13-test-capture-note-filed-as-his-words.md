---
failure: A note an agent filed from its own marked test capture was recorded in thnkr.ing as Tejas's words and could not be removed by the test cleanup.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Test-capture notes were filed under the bare capture hash

## What was seen

The thread gardener (concierge:9579, request bfa3222f) sent two captures through `router-actions.sh test-capture` and filed them with `sessions note`. Both were retained in the ledger as origin `agent` with `capture.source.metadata.agentSource` naming its run. The note receipts show capture ids `0e97b525…` and `32503355…` sent to thnkr.ing unchanged. thnkr.ing's `/captures/note/forget-test` refused them, because it only takes `agent-test-…` ids.

## Cause

thnkr.ing decides three things from the `agent-test-` prefix on a capture id: the source and note are written as the acting agent rather than as Tejas, the capture is left out of his passages, and `forget-test` may archive it. `SessionOwner.noteSource` and `noteKey` passed the retained capture's bare hash, so a marked test capture arrived looking like his own capture. That repeats thnkr.ing failure case `thinkering-agent-test-capture-stored-as-his-words` through the full test-capture plus note path.

## Fix

`captureNoteKey` files a capture retained as origin `agent` with a marked run (and not an agent report, which is a real agent issue) under `agent-test-<hash>`, both when it is saved and when a later note is added to it. Every other capture keeps its plain id. thnkr.ing needs no change: it already speaks this contract.

## Acceptance scenario

- **Seed:** An agent sends one capture through `test-capture`.
- **Action:** It files the capture with `sessions note`, then calls thnkr.ing's `/captures/note/forget-test` with `agent-test-<capture hash>`.
- **Expected:** The note's source is written by the agent, and cleanup archives the note; none of his notes are touched.
- **Replayable offline:** yes, on a ledger copy plus the agent workspace.
