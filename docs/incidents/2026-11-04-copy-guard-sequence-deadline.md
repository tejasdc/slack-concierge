---
failure: A Concierge update stopped while its running-agent safety check was still progressing.
date: 2026-11-04
fix_commits: []
cause_status: best-explanation
---

# Safety check exhausted a sequence-wide child deadline

## What was seen

Incident `a57a6835-595d-4da6-a452-0588590548b5` rejected candidate
`22f512ad6ff6a31246316c94ee325fa8d3a24a32` during preparation. The reported
last-known-good runtime was `51f938f9dfcd9e38e327b94017e021ca15cec99c`.
Retained output at
`/var/lib/slack-concierge-deployment/candidate-check-failures/11f8841a-0ebc-4d37-8990-37f57a1ed3a6-presentation/`
ends after `database-safety`, with `Running agent copy guard failed:` and no
child error. No guard assertion or termination signal was retained.

The abandoned scratch directory `/tmp/concierge-live-copy-hook-TyjWrr` was born
at 12:49:55.689 EST. Its guard bundles were written at 12:49:56.569 and
12:49:57.160, the wrapper at 12:49:58.267, and its last input at
12:50:04.482. That input is the fixture's benign Node JSON-parsing case, the
ninth wrapper invocation. Earlier assertions must have returned successfully
for that input to be written. The scratch directory's existence also shows
the fixture did not finish its unconditional cleanup.

## Cause

Confirmed source defect: the presentation gate imposed a ten-second timeout
on the entire copy-guard fixture, including two builds, wrapper installation,
and dozens of sequential subprocess launches. This treats accumulated process
startup time as a single hung operation. The fixture's individual subprocesses
had no deadlines. Its parent discarded exit/signal details and printed only
stderr, producing an empty explanation when a child was terminated silently.

The retained timestamps and progress make exhaustion of that aggregate timeout
the best explanation. They do not prove which signal ended the process or why
individual launches took their observed time. The candidate-to-LKG source diff
does not change this guard or its launcher. Authorship mappings are not causal
evidence. No production database was opened during this investigation.

## Fix

Apply the existing ten-second child bound to each actual subprocess operation.
Remove the aggregate ten-second bound from the fixture invocation; the existing
180-second controller deadline still bounds preparation and preactivation.
Keep every assertion, the generated wrapper, pinned-hook compatibility and
database isolation unchanged. Stream numbered operation progress through the
parent to retained stderr, and include status, signal and elapsed time on failure.
This assigns hang detection to individual operations rather than choosing a
larger arbitrary allowance for their cumulative startup cost.

Tests and reviews were explicitly forbidden and were not run. This source
correction is not activation or health proof; integration and those checks belong
to the external supervisor and detached controller.

## Acceptance scenario

- **Seed:** Run the candidate-owned presentation gate in its normal isolated
  deployment environment, with process startup slow enough that the complete
  copy-guard sequence exceeds ten seconds while each operation completes within
  ten seconds.
- **Action:** Prepare the candidate through the normal detached controller.
- **Expected:** The guard completes all assertions and reaches
  `presentation-check: live-store-copy-guard`. A failed or hung operation names
  its number, status, signal and elapsed time; an outer timeout retains the last
  operation marker. The complete gate remains bounded by the controller.
- **Replayable offline:** yes, on an isolated Linux host with the fixture's
  expected synthetic or protected canonical state layout; no live ledger writes
  or candidate activation are required to exercise the gate.
