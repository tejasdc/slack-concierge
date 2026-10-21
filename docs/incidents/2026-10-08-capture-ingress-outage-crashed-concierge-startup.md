---
failure: A short capture-intake outage made Concierge exit at startup repeatedly until it exhausted its own restart limit and stayed down for minutes.
date: 2026-10-08
fix_commits: [e4f0d52a, d25df0c5, 43e5b20c]
cause_status: confirmed
---

# A capture intake outage repeatedly crashed Concierge at startup

## What was seen

At 08:04 UTC on 2026-10-08 capture ingress had hit its systemd start limit. Concierge started, its one-shot
readiness check against the capture queue failed, it exited, and five exits in 30 s used up its own restart
limit. Concierge stayed down about three minutes.

## Cause

Confirmed from the commit message and diff. `CaptureDeliveryWorker.start()` awaited a `ready` promise that
resolved only after the first successful `claimNext` against the capture queue. A single failed call rejected
startup, so Concierge's availability depended on a separate service being up at that instant, and the
resulting exits counted against systemd's `StartLimitBurst`. (e4f0d52a says the check was one-shot, not
routed through the queue's retry policy; the exact earlier retry wiring was not inspected.)

## Fix

- e4f0d52a: the startup check goes through the queue's existing retry policy like every other capture queue
  call.
- d25df0c5 (`capture-delivery-worker.ts`, `deploy.sh`, `DEPLOYMENT.md`): the worker starts without waiting for
  ingress. An unreachable queue is a `CaptureQueueUnavailable` state, logged as
  `capture_delivery_queue_unavailable`, shown as unavailable in owner status, retried on the poll interval and
  logged `capture_delivery_queue_reconnected` when a claim works; captures stay in the ingress-owned queue. An
  invalid claim response stays fatal. Deploy also leaves an unchanged ingress running and no longer gates the
  Concierge release on its health.
- 43e5b20c: an update revives a stopped capture ingress and files one self-closing notice while delivery
  cannot reach it.

## Acceptance scenario

- **Seed:** capture ingress stopped (or refusing connections) while Concierge starts.
- **Action:** start Concierge, wait several poll intervals, then start capture ingress.
- **Expected:** Concierge stays online with no exit or restart-limit trip; owner status reports capture
  delivery unavailable with a reason, one `capture_delivery_queue_unavailable` is logged, and after ingress
  returns `capture_delivery_queue_reconnected` is logged and queued captures are delivered in order.
- **Replayable offline:** yes (run the worker against a local stand-in queue server that is initially down)
