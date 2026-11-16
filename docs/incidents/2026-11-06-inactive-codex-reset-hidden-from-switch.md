---
failure: An external Codex reset showed room on a saved account while Inbox work remained queued on the exhausted active account.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# A saved Codex reset did not release the Inbox

## What was seen

At 17:26 UTC, the server's fresh CodexBar reading showed the active `tejas@chann.app` login at 100% of its weekly window and the saved `tejastej.dc@gmail.com` login at 0%, with the latter's next weekly reset on November 13. The owner had read both accounts every three minutes. The Inbox router remained bound to Codex with queued work. The live ledger had no running Codex turn, but retained an older refusal for the saved personal account until November 11. Claude's two saved server logins were unreadable (`no_credentials` and `relogin_required`), so a Claude handoff was not a proven route.

## Cause

The periodic reader retired a superseded Codex refusal only for the account currently active in the shared Codex App Server. Automatic account switching evaluated saved accounts against those retained refusals. The freshly reset saved account therefore appeared unavailable to the switch even though its direct source reading showed room. The periodic check ran; its reconciliation scope was wrong.

## Fix

On each periodic reading, reconcile the refusal for every directly read, fresh Codex account before evaluating room. The existing reconciliation requires a later same-account observation, room in every included window, and a changed reset boundary. Automatic switching retains its existing idle-turn guard, account move, App Server restart, identity proof, rollback, and queued-work release.

## State card

- **Entity and writer:** each Codex account's refusal is owned by the Concierge ledger writer; the selected account is owned by the guarded App Server switch.
- **Identity:** the refusal uses the provider account ID; the reader's label resolves to that saved account ID. The switch has its own operation ID.
- **Acceptance:** a CodexBar reading proves provider-reported room for its saved login; a cleared refusal proves Concierge will consider it; an applied switch proves the running App Server identity; a resumed Inbox turn proves delivery to Codex.
- **Retained state:** the old refusal remains until direct, newer, matching-account evidence supersedes it. Peer or stale readings do not clear it.
- **Lifetime:** the three-minute reader and one-minute switch check survive as owner startup paths; queued inputs remain durable across restarts.
- **Old readers:** no new record shape or wire field is introduced.
- **Failure trace:** account A exhausted; account B refused; B reset externally; direct B reading showed 0%; B's old refusal kept the Inbox on exhausted A.
- **Falsifying check:** after installation, a fresh B reading clears only B's old refusal, the guarded switch selects B while no Codex turn runs, and an existing queued Inbox input starts and produces its routed result.

## Acceptance scenario

- **Seed:** Active Codex account A has a spent weekly window; saved account B has a cached refusal and an earlier reset boundary; the Inbox has queued Codex work; no Codex turn is running.
- **Action:** Reset B outside Concierge and let the periodic account reader fetch its new direct window.
- **Expected:** B's refusal retires without clearing A's; the guarded switch activates B and proves its identity; the existing Inbox work starts without re-accepting or duplicating its input.
- **Replayable offline:** partly; the window/refusal transition is deterministic, while App Server identity and Inbox delivery require the installed system.
