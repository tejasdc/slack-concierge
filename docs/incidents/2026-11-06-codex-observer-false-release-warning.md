---
failure: Brief Codex relay unavailability during a Concierge release published false Repair stopped notices.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Brief release handoff appeared as stopped Codex observation

## What was seen

The 22:39 and 22:57 UTC ordinary releases raised Repair stopped notices for both
Codex observers. In the 22:57 release, the runner relay returned 503 to both
observers from 22:57:02.846 through 22:57:04.470. They each exhausted five
retries and published a notice after about 1.6 seconds. The shared App Server
readiness check succeeded at 22:57:08.405, and the observer breakers later
cleared. No accepted turn was replayed or restarted to investigate this report.

## Cause

The shared readiness probe correctly keeps trying while the runner reconnects.
Each observer has a separate connection and a five-attempt fast retry budget.
Its retry breaker treated exhausting that short budget as sufficient evidence
for a person-facing stopped notice, even though it continues capped probes and
can recover moments later. The notice therefore described a retry-rate switch
as a sustained outage.

## Fix

The observer still switches to capped probes after five failures. Its breaker
retains the original failure time across owner restarts, but publishes a stopped
notice only after at least one minute of continued failure and another failed
probe. Success clears the breaker and resolves any notice already published.
This changes neither turn admission nor the shared App Server process.

## Acceptance scenario

- **Seed:** Start a new observer breaker with a runner relay returning 503.
- **Action:** Fail five fast attempts, then let the relay recover six seconds
  after the first failure.
- **Expected:** The observer reconnects and clears its breaker without a Repair
  stopped notice.
- **Replayable offline:** yes (the breaker clock is injectable; the repository's
  agent-run test gate refused execution during this repair).

- **Seed:** Start a new observer breaker with a sustained unavailable relay.
- **Action:** Fail five fast attempts and a later probe after a full minute,
  including an owner restart between them.
- **Expected:** Exactly one Repair stopped notice is recorded; a later successful
  observer connection resolves it.
- **Replayable offline:** yes (durable breaker state and notice callback can be
  exercised with an in-memory ledger when the test gate permits it).

Installed acceptance requires a subsequent ordinary release: the relay's short
503 interval must produce no new Repair stopped notice, while the real connection
and any active Codex turns recover normally. A live sustained outage must not be
induced just for a receipt.
