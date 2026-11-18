---
failure: Every new server Codex turn sat "queued" with no explanation for over an hour while the Codex re-home repair waited for long-running turns to finish.
date: 2026-11-17
fix_commits: [3afae032]
cause_status: confirmed in code; the exact origin of the retained holder row was not readable from the investigating runner shell
---

# Codex re-home hold queued all server Codex work

## What was seen

From 23:50Z on November 17 (6:50 PM Eastern) no new server Codex turn started. The thnkr.ing
co-writer (concierge:7302, bug report 9fe3143d) and sessions 6275, 9680, 10069 and 9515 showed a
bare "queued" with no status detail. Claude turns ran normally. Tejas was blocked on the co-writer.
The owner journal (release 8ef9025) showed one `codex_unmanaged_server_repair_waiting`
(`running:2, external:1`) at owner start and no repair event after it. The running turns it waited
for (concierge:10028 since 19:07Z, concierge:8756) were hours long.

## Cause

`repairUnmanagedCodexServer` took `codex:runner-rehome:<runner>` with a durable recovery row
*before* counting running work. When a durable row already existed (`recovering`), the waiting
return kept the hold. Such rows outlived their purpose because:

- `runner ax41 has no call channel` is a `RunnerUnreachableError`, not `RunnerCallNotSentError`, so
  an attempt that never reached the runner still retained the hold and started a reconciliation;
- the reconciliation kept the hold on a `busy` answer (silently) and on any unproven answer;
- a refused or unproven direct answer also retained the hold;
- nothing bounded a holder's age, and every owner start restored the row into the in-memory
  admission set, then waited again.

The result: admission stayed closed until every Codex turn on the server ended, which on a busy
server is never. The queued receipts had no status for an admission hold, so nobody could see why.

## Fix

- Count running Concierge and outside Codex turns first; while any run, log the wait with
  admission open. Hold only for the swap, re-count under the hold, release on any runner answer.
- The reconciliation releases the holder on any answer (under the restart lock, so it cannot drop a
  newer re-home's hold); a `busy` answer only re-arms the retry.
- Re-home and account-switch holders expire five minutes after they were first taken (their runner
  calls are bounded at 220 s and 130 s), at owner start and on a 30 s sweep, logged as
  `codex_admission_hold_expired`. A stale account-switch reconciliation stops with its holder.
- A queued Codex input behind a durable holder shows `CODEX_ADMISSION_HELD` with a plain message and
  `clearsAt`, computed from the ledger so the owner and the presentation worker agree.

Releasing the wedge needed no manual ledger edit: installing release 5f6d544a at 01:22:57Z on
November 18 restarted the owner and queued Codex work started (concierge:7302, 9680 and 10069 ran
and completed); running turns 10028 and 8756 were untouched. The new owner logged
`codex_unmanaged_server_repair_waiting` with `admission:"open"` and no `codex_admission_hold_expired`,
so no aged durable holder row survived: the holder that kept admission closed in the old process was
held in memory only, and the journal never named it. The hold-before-count ordering above is a
proven way to close admission while waiting; whether it was that holder this time is unconfirmed.
A follow-up commit logs every holder-set change (`codex_admission_holders_changed`) and any holders
restored at start (`codex_admission_holders_restored`), so the next occurrence names its holder.

## Acceptance scenario

- **Seed:** disposable ledger; a queued shared Codex turn; a runner re-home holder, then a runner
  account-switch holder, then source-bound runtime maintenance.
- **Action:** claim through the real queue; read the hold fact; age the holder past the bound and
  re-hold it; run the expiry; claim again.
- **Expected:** a fresh holder blocks and its fact names `clearsAt = since + bound`; re-holding keeps
  the original start; the aged holder expires and the original queued turn is claimed. Runtime
  maintenance is never expired by this bound and an outside run is not told it waits on it.
- **Replayable offline:** yes; `bun run scripts/codex-outside-admission-fixture.ts` from `bot/`.
  The repair ordering itself needs a runner and is checked on the installed release.
