---
failure: A Concierge update failed its release check because a fresh database spent eleven separate disk commits creating early tables on a slow disk and ran out of time.
date: 2026-10-16
fix_commits: [30da7da3]
cause_status: best-explanation
---

# An update failed its message-admission check on slow early schema setup

## What was seen

On 2026-10-16 the candidate check for release `2bdcdfbe` failed and the update did not install. The accepted-input
admission child exhausted its 30-second deadline after `owner-loaded` and before `queue-verified`. Its one
successful queue claim (04:45:34.575 UTC) took 582 ms, 580 ms of it outside the measured claim work. During the same
preparation the serving owner logged disk syncs of 1,001–2,040 ms, and later deployment transactions spent 1,385 ms and
2,994 ms in commit with zero writer wait. No request-custody assertion failed.

## Cause

`bot/src/state.ts` creates the early control tables (`provider_usage_cache`, `antigravity_usage_cache`,
`global_pause` and its exceptions/actions, `focus_hold` and its actions) with separate `db.exec` calls at module load,
before the existing batched base-schema transaction. Multi-statement `db.exec` does not group SQLite commits, so on a
fresh ledger those nine table creations and two seed inserts were eleven independent durable commits. With each sync
taking one to two seconds, that alone could cost well over ten seconds of the child's budget. The defect predates the
candidate's request-routing changes.

Best explanation: the commit amplification plus slow storage pushed the child past its deadline. Not observed: import
and individual schema timings were not retained, so this code's share of the 30 s is unmeasured
(`docs/architecture/STORAGE-OBSERVATION.md`, "Startup transaction ownership").

## Fix

30da7da3 wraps the early control schema and its seed rows in one `db.transaction(...).immediate()`, turning eleven
durable commits into one. Reader exclusion (read executors skip all schema batches), nested savepoints under the
deployment migrator, durability settings, the foreign-key migration boundary before `initializeSessionOwnerSchema`,
and the candidate deadlines are unchanged; nothing was retried or extended. Completion under the new batching was not
measured at commit time; the supervisor and detached controller own that proof.

## Acceptance scenario

- **Seed:** An empty state directory and the release's accepted-input admission fixture, with fsync latency raised to
  ~1–2 s per sync (throttled loop device or `dm-delay`).
- **Action:** Run the candidate admission check (fresh ledger, owner load, admit and queue one input).
- **Expected:** Ledger initialization performs one commit for the early control tables (observable as one WAL sync
  in `strace -e fdatasync` or SQLite's commit hook) and the child reaches `queue-verified` within 30 s.
- **Replayable offline:** yes (scratch ledger plus artificial disk latency)
