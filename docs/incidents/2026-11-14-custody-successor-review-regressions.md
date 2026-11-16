---
failure: A recovery candidate could lose separate duties, override Pause, forget a constructed conversation, or falsely certify an older application.
date: 2026-11-14
fix_commits: []
cause_status: confirmed
---

# Recovery source review exposed custody and compatibility failures

## What was seen

The first whole-feature review of the custody-successor candidate identified concrete
failure sequences before installation. The selected attempt shared its execution target
with other transferred duties; construction completion cleared the same suspension flag
used by a newer Pause; later resource failures discarded an already received native
identity; recovery staging could reuse an ordinary handoff action; and an old release
builder could seal an old application with the new controller's capability file.
The reviewer reproduced the old-builder artifact counterexample. The production observer
callback also independently resumed newly bound threads and repeated that on reconnect.
Verdict2 then found that a confirmed selected Stop/error disabled later distinct work,
Continue stranded the admitted-before-acknowledgement interval, unhealthy rollback tried
offline pointer publication before stopping the candidate, and supported old-application
hybrids lacked the new publication receiver. Complete peer-source clarification also
found selected-attempt fanout to transferred incoming duties and a successor final proof
being compared against the origin's historical predecessor identity.

These are source/disposable-state findings. No target recovery or installed repair is
claimed. The corrected native transport boundary covers actual managed senders;
actual target association and any applicable external/legacy transport coverage
remain activation evidence, separately from whole-feature source review.

## Cause

Custody was coupled to the outcome of one execution placement, a passive construction
hold was indistinguishable from an explicit control, and construction observation was
stored only after later validation. Handoff idempotency omitted operation kind and the
canonical selected reminder. A capability hash proved file integrity without proving its
application-source origin in a hybrid release. Observer subscription used the ordinary
cold-resume path even when the execution host had selected protected observation.

## Fix

Transferred duties retain their own dispositions when the selected attempt fails.
Explicit Pause has distinct retained control state. Construction identity is persisted
before later awaited validation. Recovery staging binds kind, canonical reminder and
passivity. Hybrid release activation checks application-source capability provenance.
Production binding and observer reconnect paths use protected read-only observation.
The exact native connection is pinned, and protected sends refuse implicit reconnection;
this association check does not claim native writer exclusion.
The parent's later paused-successor reproduction found the suspension refusal ran
before exact Stop validation. Stop now validates its retained active turn and Stop
input before the productive-admission hold; it does not bypass connection custody
or clear Pause.
Verdict2 separates the selected attempt's acknowledgement/native terminal receipt from
successor availability. After confirmed selected Stop/error, a later distinct admission
requires the original connection and fresh exact-thread effects; the final forward guard
requires its turn/attempt receipt. Unknown outcomes remain held and the allowance stays spent.
Continue recognizes admitted construction before acknowledgement. Peer status and final-proof
consumers resolve the exact accepted custody chain while preserving historical acceptance;
unconfirmed first pushes remain pending and selected outcomes do not settle inherited duties.
Release publication discovers the actual application's supported lane. Legacy/unhealthy owners
are positively stopped before offline publication; healthy capable owners serialize it.
Post-start offline inheritance is cleared and rollback retains drains through restored health.
The existing child-bridge generation fixture also explicitly disables daemon
management: selecting a fake bridge must not retain the production client's host
tuning/start defaults during a disposable-only acceptance run.

## Acceptance scenario

- **Seed:** A real managed disposable client, accepted selected reminder, exact native
  acknowledgement, original connection, and three retained writing duties.
- **Action:** Run `bun run scripts/codex-custody-successor-fixture.ts`. Its stock-native
  substitute confirms exact Stop through direct and reconciliation-loop interruption,
  or confirms selected error, before the real coordinator reconciles the terminal placement.
  Only then does a distinct input run through the owner, execution host and final byte guard.
- **Expected:** Duties stay open; later native acknowledgement/useful output succeeds;
  canonical allowance remains spent; a nonempty native queue holds a further admission.
  Pause remains deliberate, and Continue during admitted does not strand acknowledgement.
- **Replayable offline:** yes (actual owner/client/guard, substituted native responses).

- **Seed:** Accepted incoming peer duties transferred to the selected placement, or an outgoing
  child returning after its requester transferred custody.
- **Action:** Run `bun run scripts/codex-custody-peer-fixture.ts` from `bot/`.
- **Expected:** Status polling and notifications retain independent duties after selected failure,
  Stop or consultation completion; exact successor finals settle once in either arrival order;
  historical acceptance stays intact; late child return follows the current holder without resend.
- **Replayable offline:** yes (actual producer/consumer with controlled transport).

- **Seed:** A preserved old application receiver, corrected controller, compatible LKG, and
  disposable systemd/health transitions including an active unhealthy candidate.
- **Action:** Run `bun run scripts/release-application-compatibility.ts` from `bot/` with
  explicit disposable state/test authorization.
- **Expected:** Ordinary predeployment restore, hybrid promotion and control recovery use a
  positively stopped owner when needed. Failed health restores/restarts compatible LKG under
  retained drains. Capable publication is serialized; arbitrary RPC failure never falls back live.
- **Replayable offline:** yes (actual receiver/CLI/shell; host effects substituted).

- **Seed:** A paused protected successor with an active followup and retained human Stop.
- **Action:** Run `bun run scripts/codex-custody-forward-guard-fixture.ts` and
  `bun run scripts/codex-custody-connection-fixture.ts` from `bot/`.
- **Expected:** Exact Stop passes while Pause stays set; productive admission/steering,
  missing or wrong Stop identity, terminal turns and replacement connections refuse.
- **Replayable offline:** yes (isolated database and disposable bridge).

- **Seed:** A terminal unacknowledged Astra Medium reminder, multiple already accepted open
  duties, passive successor construction, and a disposable native substitute.
- **Action:** Run `bun run scripts/codex-custody-successor-fixture.ts` from `bot/`, including
  a terminal empty recovery attempt and supported Pause while construction is delayed.
- **Expected:** Separate duties remain open and accept their own legitimate replies;
  the newer Pause survives; received native identity survives later validation failure;
  the positive same-connection owner path records one acknowledgement and useful result.
- **Replayable offline:** yes (isolated owner database, disposable workspace and native substitute).

- **Seed:** An ordinary handoff already uses the repair action identity, or authority changes
  during asynchronous inventory collection.
- **Action:** Run `bun run scripts/codex-custody-handoff-fixture.ts`.
- **Expected:** Recovery refuses the collision or changed authority before custody moves;
  the existing handoff and original obligations remain unchanged.
- **Replayable offline:** yes.

- **Seed:** The exact old builder, old application and new controller in disposable release roots.
- **Action:** Run `bun run scripts/release-application-compatibility.ts`.
- **Expected:** Current activation refuses the falsely advertised hybrid; compatible
  same-commit output and correctly proven hybrid output still activate in disposable state.
- **Replayable offline:** yes (uses local Git objects and fake service commands).

- **Seed:** Protected successor/predecessor bindings and an observer connection loss.
- **Action:** Run `bun run scripts/codex-protected-observer-fixture.ts` and
  `bun run scripts/codex-custody-connection-fixture.ts`.
- **Expected:** Production observer composition and reconnect do not cold-resume protected
  threads; the same native connection works, but a changed connection or client holds
  protected calls before sending.
- **Replayable offline:** yes.

Verdict3 found that a peer final retained before a handoff was refused afterwards (its
proof named the predecessor while status and pull named the successor), and that an early
first-cutover failure left the owner stopped with both admission drains released. Status,
push and pull now carry each retained reply's original author, validated against the
committed handoff chain; the cutover script takes its unit copy before the first stop,
restarts the original owner on any failure and releases the drains only after the restored
owner and capture ingress pass their probes.
