---
failure: Routine Concierge releases filed repair notices saying Codex conversation and Codex Remote observation had stopped, though Codex never failed.
date: 2026-11-11
fix_commits: []
cause_status: confirmed
---

# Every release told the repair agent Codex had stopped answering

## What was seen

On 2026-11-06 05:51 UTC, 2026-11-09 03:31 UTC and 2026-11-11 04:35 UTC (and on other busy-night
releases, about four an hour) the repair agent received "Codex conversation observation stopped
after repeated failures" and "Codex Remote observation stopped after repeated failures". Codex
answered 3–10 seconds later each time (`codex_app_server_ready`); nothing had failed.

## Cause

The Codex App Server runs on the ax41 runner and the owner reaches it through the runner relay.
While the owner restarts, or the runner restarts earlier in the same release, the relay has no
listen channel and refuses with 503 `RUNNER_NOT_LISTENING`. Both observers record each refused
connect on their retry breaker under the `observer` policy, which tripped on its attempt bound:
five attempts starting at 100 ms. Five refusals took 1.9 seconds, so a planned gap of a few
seconds tripped the breaker and filed the `retry_stopped` notice. Duration was never part of the
decision. This is the same shape as `2026-10-16-peer-down-false-alert-on-update.md`.

## Fix

The `observer` retry policy (used only by the two Codex observers) now trips on its deadline:
two minutes of continuous failure, with the attempt bound raised to 50 so it never decides first.
Two minutes is past the longest planned gap observed (about 10 seconds from new owner to Codex
ready) and the 90-second owner-restart budget, and still reports a Codex App Server that stays
down. The observers' reconnect pacing is unchanged (100 ms doubling to 60 s). Distinguishing the
relay's 503 from an App Server failure was rejected: a runner whose relay stays closed is a real
Codex outage too, and time unreachable covers both.

## Acceptance scenario

- **Seed:** A Codex observer breaker at zero failures.
- **Action:** The App Server connection is refused continuously for 10 seconds, then answers.
- **Expected:** No `retry_stopped` notice. Refusal continuing past two minutes files exactly one.
- **Replayable offline:** yes (`bot/tests/codex-observer-breaker.test.ts`, in-memory ledger and explicit clock)
