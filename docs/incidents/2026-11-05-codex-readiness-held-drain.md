---
failure: A stopping Concierge owner waited for Codex App Server readiness with no provider run to adopt.
date: 2026-11-05
fix_commits: []
cause_status: best-explanation
---

# Codex readiness wait held a Concierge stop open

## What was seen

At 09:53:45 UTC on 2026-11-05, the owner began draining while runner ax41 was unreachable.
The stop remained active until systemd killed the owner at its five-minute limit. Ledger
inspection found two Codex turns, 22330 and 22334, still running under that owner with admission
intent but no execution record. The owner's repeated wait log was `codex_app_server_unready`.
Two unclaimed runner launch jobs timed out earlier and parked; they did not hold the final drain.
The [runner record](2026-11-05-runner-fencing-held-back-reacquire.md) covers the separate delay
in reconnecting ax41.

## Cause

The best explanation from the ledger and source is that both Codex turns were inside an
unbounded App Server readiness wait. Admission intent was recorded before that wait, but no
execution host was recorded yet. The drain counts such turns as work held by this process and
waited for them; the readiness probe kept retrying while the runner relay was unavailable.

## Fix

The readiness wait now belongs to the serving owner's lifetime. Drain ends that turn's wait
before provider admission, and the existing proven-unsent transition returns its exact input
to the queue. Admission intent and the execution record are written together after readiness;
an execution already recorded keeps its host custody and is adopted after restart. The shared
readiness probe still retries through temporary relay failures while the owner is serving.

## Acceptance scenario

- **Seed:** a Codex turn waiting for an App Server readiness probe that cannot answer, before
  provider admission or execution intent.
- **Action:** begin owner drain.
- **Expected:** the readiness wait ends, the exact turn is requeued unsent, and the next owner
  can claim it. A turn with an execution record remains adoptable instead.
- **Replayable offline:** partly. `bot/scripts/codex-readiness-check.ts` exercises an unresolved
  probe ending on drain, and `bot/tests/runner-drain.test.ts` exercises the proven-unsent ledger
  transition. The installed restart and relay entrance still need a live check.
