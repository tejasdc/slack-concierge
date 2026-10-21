---
failure: A Concierge update failed its release check because a diagnostic database write inside the check used up the check's time before the real test ran.
date: 2026-10-16
fix_commits: [dfd82871]
cause_status: best-explanation
---

# An update failed its dispatch check on a diagnostic write

## What was seen

On 2026-10-16 the candidate check for release `9a5a2307` failed and the update did not install (repair incident
`9fef91cf-19bd-4725-b968-f84826c8a928`). The dispatch-claim gate's child process reached `owner-loaded` at 13,143 ms
and `queued-with-journal` at 13,988 ms, then hit its 15,000 ms deadline before reaching `raw-control-complete`. The
actual queue claim the gate exists to prove never ran.

## Cause

`bot/scripts/dispatch-claim-fixture.ts` opened a second, raw `bun:sqlite` connection to the scratch ledger before the
real claim, ran a diagnostic `UPDATE turns ... ; ROLLBACK TO` to compare Bun's raw change count with `changes()`,
and closed it. That connection used SQLite's default auto-checkpointing, outside the canonical writer policy, so it
could add checkpoint disk work at a moment when startup had already used 14 of the 15 seconds. The retained phase
markers place the stop inside that diagnostic block.

Best explanation: slow disk made the extra raw write and its checkpoint exceed the remaining ~1 s. Not observed: which
step of the block (open, update, savepoint release, close) stalled, or why loading the owner took 13 seconds. A
nearby deployment commit took 758 ms with 0 ms writer wait, which supports disk latency but does not prove this
child's waits. The candidate's own change touched the presentation worker, which this gate starts only after dispatch,
so the failed range does not establish that the candidate caused it (`docs/architecture/DEPLOYMENT-REPAIR.md`).

## Fix

dfd82871 removes the raw diagnostic connection from the fixture and its exception from
`bot/scripts/ledger-constructor-check.ts`, so the gate uses only the canonical connection. All real assertions stay:
one claimed turn handed to the runner exactly once, its owner and dispatch attempt retained, no second claim, journal
triggers fired. The 15 s child deadline is unchanged; the fix removes unneeded disk work rather than extending the
timeout. `DEPLOYMENT-REPAIR.md`, `STORAGE-OBSERVATION.md` and `AGENTS.md` record the evidence and its limits.

## Acceptance scenario

- **Seed:** A scratch state directory and the release's dispatch-claim fixture, with disk writes slowed (for example
  a throttled loop device or `dm-delay`) so owner loading takes ~13 s.
- **Action:** Run the candidate presentation check's dispatch gate.
- **Expected:** The child goes from `queued-with-journal` straight to the real claim and `claim-verified` within the
  15 s deadline; no second database connection is opened in the child.
- **Replayable offline:** yes (scratch ledger plus artificial disk latency; no live state or provider)
