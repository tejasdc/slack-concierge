---
failure: An ambiguous shared Codex connection closure before turn submission was parked as though provider admission might have occurred.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Shared Codex setup closure parked an unsubmitted native turn

## What was seen

The daily Twitter delivery's native Codex turn 25518 had three dispatch attempts: attempt 1 was held by usage on Nov 7 at 11:00 UTC; attempt 2 was held by usage on Nov 12 at 18:55:51; attempt 3 parked ambiguous at 18:57:08 UTC after an App Server WebSocket closure. Five scheduled firings had already been skipped before that final attempt. The exact supplied owner-firing evidence records all three executions as released `codex-daemon` attempts, no adoption, explicit initial `run.sessionUUID: null` on every attempt, and unchanged provider generation 1/null binding. No provider message, turn, or acknowledgement is recorded.

The exact native turn remains parked ambiguous and is preserved. Source and canonical live readback show this released native park is not a current blocker for the later queued native firing; no retirement, replay, schedule mutation, or digest operation was performed as part of this fix. The initial chronology explains the original incident; it does not prove future delivery or publication.

## Cause

The shared Codex controller had a narrow retryable catch around `thread/start` and `thread/resume`, but `client.connect()` and `codexThreadParameters()` configuration reads ran outside it. An ambiguous transport error from those setup steps escaped as a raw client error. The turn executor treats an unconfirmed post-admission failure as ambiguous, so a setup-only closure could park a turn even though the controller had not called `turn/start`.

Separately, the shared disconnect listener rejected the one-shot `turnStarted` promise before submission. That stale rejection could remain in the final race. The controller now records a typed setup interruption and checks it before submission, instead of rejecting that promise. Adopted work is not treated as unsent because a provider effect may predate the current controller.

## Fix

Use one shared boundary for ambiguous Codex App Server transport errors before `turn/start`: classify them as terminal-confirmed retryable dispatch failures only when this attempt is not adopted and has not attempted submission. Keep every post-submission error under the existing exact-history reconciliation. Add a disposable fake-client fixture to the existing build checks and document the native parked-turn versus held-host queue distinction.

## Acceptance scenario

- **Seed:** Use the disposable fixture `bot/scripts/codex-presubmit-boundary-fixture.ts` with a temporary Concierge state directory and fake App Server client.
- **Action:** Run `cd bot && bun run scripts/codex-presubmit-boundary-fixture.ts`.
- **Expected:** Connect, config-read, and disconnect-after-thread-response faults become retryable with no `turn/start`; pre-submit Stop sends no provider request; adopted reconnect failure remains ambiguous; an ambiguous submitted `turn/start` followed by rejected exact history stays unconfirmed and is not sent twice. Against the base `codex.ts`, the fixture fails at the setup retry-classification assertion.
- **Replayable offline:** yes. The fixture makes no provider request, uses a fake client, and writes only to a disposable temporary state directory.
