---
failure: A lyrics build sent to a Codex agent was set aside as possibly started, and never run, because Codex was slow to open a conversation during a restart.
date: 2026-10-16
fix_commits: [a5a2417b]
cause_status: confirmed
---

# A Codex build was parked as uncertain after a conversation-start timeout

## What was seen

On 2026-10-16 the lyrics build requested in an Inbox thread was parked as an ambiguous (possibly started) turn and did
not run. Codex's App Server was restarting and was also timing out historical observer resumes at the time; the
build's `thread/start` request timed out after 30 seconds (`docs/architecture/PROVIDER-SESSIONS.md`). Nothing had been
submitted to the model.

## Cause

`runCodexTurnShared` in `bot/src/codex.ts` opens or resumes a Codex thread (`thread/start` / `thread/resume`) and only
then submits the user's input with `turn/start`. The App Server client (`bot/src/codex-app-server-client.ts`) rejects a
timed-out or disconnected request as `CodexAppServerClientError` with outcome `ambiguous`. That error propagated
unchanged from the thread-open step, and the owner treats an ambiguous provider outcome as "the work may have begun":
it parks the turn, fences its successors and never replays it. For this step that was wrong. Neither `thread/start`
nor `thread/resume` sends the user's input, so even if the App Server created a thread before its answer was lost, no
requested work could have started.

## Fix

a5a2417b catches an ambiguous `CodexAppServerClientError` from the thread-open step and rethrows it as a
`ProviderDispatchError` with `terminalConfirmed: true` and `failureClass: "retryable"`. The accepted Concierge turn
then retries under the same input identity instead of parking. Ambiguity after `turn/start` is unchanged: it still
goes through reconnection, `thread/read` reconciliation and, failing proof, parking. `PROVIDER-SESSIONS.md` and
`AGENTS.md` record the boundary.

## Acceptance scenario

- **Seed:** An accepted Codex turn for a new session; a stand-in App Server that never answers `thread/start` (so the
  client's 30 s request timeout fires), then answers normally on the next connection.
- **Action:** The owner dispatches the turn.
- **Expected:** The first attempt fails as retryable, the turn returns to its queue (not `parked_ambiguous`), the retry
  opens a thread and submits `turn/start` exactly once, and the input ID is unchanged. A timeout on `turn/start` instead
  still follows the reconciliation path.
- **Replayable offline:** yes (stand-in App Server over the same JSON-RPC protocol; no real Codex model)
