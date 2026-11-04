---
failure: An answered historical ChatGPT check prevented an agent from finishing unrelated new requests.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# An old ChatGPT check held later requests

## What was seen

The ChatGPT channel session could not send final replies for three completed November 4 requests. Concierge said its answered October 14 ChatGPT channel check had unclassified task custody.

## Cause

The initial historical scan listed every currently open request to the asking session as a possible task for a human sourced ChatGPT question. It did not check whether each request existed when the question was asked. The October check's direct human task had already recorded a done outcome; four November requests were therefore attached as false candidates.

## Fix

The historical scan and its startup reconciliation now retain only tasks that existed at question time and remain open. When none remain, the old question is classified as excluded from open work; it cannot hold future tasks. The original request and answer history stay intact. No browser action is repeated.

## Acceptance scenario

- **Seed:** An answered ChatGPT ask from a direct human input whose task is done, followed weeks later by open requests to the same asking session. Include a previously saved pending row that lists those later requests.
- **Action:** Start Concierge and send a final reply for one of the later requests.
- **Expected:** Startup removes the false candidates and the final reply is accepted. A still-open task that existed at question time remains a candidate and is held until its old question is classified.
- **Replayable offline:** yes (a ledger fixture can retain the question, terminal direct outcome, later requests, and pending row).
