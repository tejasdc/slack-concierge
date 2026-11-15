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
The existing child-bridge generation fixture also explicitly disables daemon
management: selecting a fake bridge must not retain the production client's host
tuning/start defaults during a disposable-only acceptance run.

## Acceptance scenario

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
