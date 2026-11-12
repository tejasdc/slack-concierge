---
failure: A lost Codex App Server connection parked 36 turns that had sent nothing as "outcome unknown", and 10 of them waited 50 minutes until an agent resumed each by hand.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Ten Codex sessions sat stopped for 50 minutes after an account switch

## What was seen

At 18:56:52 UTC Concierge moved Codex to another account (only while no Codex turn was running),
which restarted the App Server on the runner and closed its four relays. At 18:56:58 the switch
released 37 held turns at once ([held-work record](2026-11-12-account-switch-released-held-work-at-once.md)).
They were claimed, built their context (`thesaurus_turn_context` ×36) and began connecting to the
App Server, which was still coming back. At 18:57:08 the runner did not accept the relay in time,
the bridge reported `Codex app-server WebSocket closed.`, and within 120 ms all 36 turns logged
`provider_turn_parked` with `parked_ambiguous` and that same raw error. No turn logged a turn/start
failure, a resume wait or a reconciliation attempt: none had sent its input. Ten stayed parked until
session 9451 sent each a "resume your task" request at 19:45. No `execution_adopted` event appeared
in between: nothing in Concierge ever looked at them again.

## Cause

Two gaps, both confirmed in code.

1. **An unsent turn was parked as possibly sent.** Concierge records "admission intended" before it
   calls Codex, so any failure without proof that Codex did nothing is treated as possibly sent and
   parked. Losing the connection during `thread/start` or `thread/resume` was already converted into
   that proof, but the connect before them was not: a turn waiting in `client.connect()` received the
   bridge's raw "WebSocket closed" error and parked. (Converting it into an ordinary retry would not
   have been enough either: 36 failures at once would have spent the provider-wide retry budget of
   five and parked the rest.)
2. **A parked Codex turn was never followed again while Concierge ran.** A Codex turn's run record
   (`supervisor='codex-daemon'`) is released as soon as its run returns, including when it parks. The
   minute sweep for parked runs only looks at unreleased records, so it took a parked Codex turn back
   only after a Concierge restart. The thnkr.ing reconcile control only re-delivers a saved result,
   and these turns had none.

## Fix

1. Before turn/start, a lost connection is waited out on the same attempt (1 s doubling to 30 s,
   Stop still ends the wait): the turn reconnects, asks for its thread again and sends its input
   once. No retry budget is spent and nothing parks. An unanswered `thread/resume` on a live
   connection keeps its existing per-conversation retry.
2. The minute sweep also takes back a Codex turn parked as uncertain in the last 24 hours whose
   record was released, provided no later turn in its session was sent. It follows the turn from its
   exact thread history: a finished turn is settled with its answer, a running one is followed live,
   and a turn the whole history never shows, with no provider turn id, comes back as a safe retry
   (it never reached Codex, so sending it repeats nothing). Two turns per sweep, oldest first; a turn
   is taken back at most three times and then stays visibly parked.

The account switch itself already waits until no Codex turn is running, so it does not cut running
work; the turns it hit were the ones it had just released, still connecting.

## Acceptance scenario

- **Seed:** a shared App Server client whose connect fails once and whose `thread/resume` fails once
  with "WebSocket closed"; three Codex sessions with turns parked as uncertain and records released.
- **Action:** run the turn; run the parked-run sweep three times.
- **Expected:** the turn finishes and sends turn/start exactly once; the sweep takes back two parked
  turns, then the third, and stops taking back a turn after three tries; a taken-back turn absent
  from its thread's history returns a retryable, provider-confirmed failure and is never sent by the
  taking back (`bot/scripts/codex-connection-loss-fixture.ts [--adopted]`,
  `bot/scripts/parked-codex-follow-fixture.ts`).
- **Replayable offline:** yes
