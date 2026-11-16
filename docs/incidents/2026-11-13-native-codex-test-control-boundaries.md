---
failure: Native Codex test controls could cut ordinary work and could cut again after Stop, while an adopted Stop with unconfirmed history could look confirmed to its caller.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Native Codex test controls crossed their retained boundaries

## What was seen

Fresh review of local candidate `a0a6dd56` found that every agent-created Codex session silently
received the dedicated connection path and its loss/Stop controls. A separate isolated replay of
the actual owner accepted a connection-loss action after the same run had retained Stop: Stop
returned HTTP 200, loss returned HTTP 200, and one client cut was invoked. A repeated loss action
after terminal settlement returned stale instead of its saved receipt. The execution host also
left a dedicated client open on canonical `error` terminal status and overwrote clients on durable
replacement without closing the previous one.

The adopted-Stop recovery path already kept provider work uncertain when history was refused, but
the cancellation callback returned normally. Its owner Stop receipt could therefore read as still
running. Empty history after repeated exact-history searches was not covered by the prior fixture.

## Cause

Dedicated-client selection was inferred from generic agent authorship rather than a retained
disposable-test choice. The fault action checked only that the run was running, not that Stop was
absent, and looked up the target's live status before resolving a duplicate operation. Cleanup
used statuses that the turn ledger does not emit. Adopted cancellation awaited reconciliation but
did not rethrow its retained unconfirmed outcome to the normal Stop owner.

## Fix

The create command now carries an explicit finite future test deadline, retained on that exact
create input. Only that marked local Codex input uses the existing dedicated client; ordinary
agent-created work keeps the shared client. The owner requires the marker for both source-bound
controls. Loss intent records its execution, dispatch attempt, generation and deadline before the
host's final live ownership, Stop, generation and deadline recheck. A proven no-effect refusal does
not consume the one-cut budget; uncertain intent does. Stable duplicates return the saved result
after terminal settlement. The existing client registry closes on `done`, `error` and `cancelled`,
closes replaced clients, and retains ownership when close observation fails. Adopted Stop now
returns unavailable and empty-history uncertainty through the normal Stop receipt without retrying
or resubmitting accepted provider input. The account-switch baseline remains a shared-client
continuation; disposable fault targets are separate creations.

## Acceptance scenario

- **Seed:** Isolated owner state with an ordinary unmarked agent-created Codex session, a separately
  marked disposable target and one exact source input/run pair.
- **Action:** Attempt loss on the ordinary session; retain Stop on the selected target and attempt
  loss afterward; cut a selected target and repeat its stable action after settlement; finish a
  dedicated run with `error` or replace its client; reconcile adopted Stop through exact, missing,
  empty and unavailable history.
- **Expected:** Ordinary work has no dedicated selection or fault authority. Stop prevents a later
  cut. A late duplicate returns the original receipt without another cut. Terminal and replacement
  paths close owned clients, preserving a failed-close reference for retry. Exact adopted work is
  interrupted and settled only by provider history; absent or unavailable history leaves both work
  and Stop receipt uncertain and never starts a replacement provider turn.
- **Replayable offline:** yes (isolated owner fixtures and a disposable child bridge; real daemon,
  account switch and provider history remain post-install acceptance).
