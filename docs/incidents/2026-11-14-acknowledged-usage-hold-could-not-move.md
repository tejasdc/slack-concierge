---
failure: Concierge could not move an accepted input after its exact terminal zero-work usage refusal because the turn retained its provider acknowledgement.
date: 2026-11-14
fix_commits: []
cause_status: confirmed
---

# Historical acknowledgement blocked a terminal usage-refusal handoff

## What was seen

On 2026-11-14 the accepted request `0b5867ba-8063-468a-b5df-53e72c0473e5` was held on turn
30445 in predecessor session 9557. The SAME handoff to successor session 9675 had ID
`caf336c2-5098-43f2-aaf0-089b75080748`. The provider echoed the input, then returned three
synthetic `rate_limit` responses at 04:55:14.385, 04:55:16.794 and 04:55:19.120; at 04:55:21
Concierge recorded the terminal queued usage refusal. The accepted input and its history stayed
queued in the predecessor while the handoff awaited acceptance. Capture
`729478940b0921af260622b075b08d2560fe26bb96c278df2430f6e3c8e83d6a` retains the source chain.
The original run is `be72fbf2-0514-4990-9259-cc93ced9d953`; the refused inventory digest was
`606c52c0ba4500b6c56c658343da94b6d1ec5c176eb12a537538aaf8ad4de6a0`.

## Cause

The movement predicate treated any retained provider acknowledgement as ambiguous, even though
Concierge had recorded the accepted turn's terminal zero-work usage refusal. The existing usage
hold is the durable proof: its writer is reached only after the dispatch path establishes replay
safety, terminal refusal and no authored output, tool use or artifact activity. An acknowledgement
without that hold remains ambiguous.

## State card

- **Entity and writer:** Concierge alone orders custody of the admitted input and proposed handoff.
- **Identity:** the original request, input, run and handoff above survive retries; acceptance links
  the successor input rather than admitting another request.
- **Acceptance:** provider acknowledgement proves pickup; the guarded refusal proves zero work;
  the digest-checked transfer transaction proves changed custody. None proves product completion.
- **Retained state:** the predecessor keeps original admission, acknowledgement and start history;
  until acceptance, its queued input and obligations remain there.
- **Lifetime:** the durable queue and proposal survive owner restarts; no provider restart is used
  to manufacture idleness.
- **Older readers:** no stored shape changes. Earlier code continues to refuse acknowledged work.
- **Lost response:** before acceptance the predecessor retains custody; after its transaction,
  a lost response or refresh reads the same accepted transfer and cannot create another successor.
- **Falsification:** the fixture rejects uncertain acknowledgements, continuations and dependencies,
  and proves a proposed handoff prevents a competing automatic transfer. Live acceptance must use
  this same handoff, its current digest, and an independent custody readback.

## Fix

Let that exact usage hold supersede historical acknowledgement and start markers without clearing
them. Continue rejecting a foreign provider admission receipt, unclassified acknowledgement or
start, unresolved dependency, steering, artifact, peer-delivery or continuation. The automatic
Claude recovery sweep also leaves a predecessor alone while a SAME handoff is proposed, so the
existing paths cannot create competing successors. Acceptance remains a guarded ledger transaction:
until its exact inventory digest is accepted, the accepted input and original turn stay with the
predecessor. A restart or refreshed usage reading does not accept or move the handoff.

## Acceptance scenario

- **Seed:** ordinary Claude input, exact provider admission receipt, retained acknowledgement and
  start history, then an owner-classified replay-safe zero-work usage refusal; also seed an
  unclassified acknowledgement and an unresolved dependency as negative controls.
- **Action:** evaluate handoff movability; invoke the existing Claude recovery transfer against a
  predecessor with a proposed SAME handoff.
- **Expected:** only the exact held refusal is movable; acknowledgements and starts remain stored;
  negative controls remain blocked; the proposed SAME handoff remains the only transfer custody.
- **Replayable offline:** yes, `bun run bot/scripts/private-code-command.ts -- bun run bot/scripts/held-work-movability-fixture.ts`.
- **Source validation:** no production ledger, provider, session, or handoff action was performed.
  Installed same-handoff acceptance remains a separate delivery check.
