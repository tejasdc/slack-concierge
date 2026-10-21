---
failure: Google withdrew the selected Gemini model, so requests to Google sessions waited with no answer, and an old session's refusal could mark the whole Google account as down.
date: 2026-10-13
fix_commits: [90e656ed, bbee3d28]
cause_status: confirmed
---

# A retired Gemini model refused work and could make the account appear unavailable

## What was seen

An audit sent to a Google (Antigravity) session never got an answer and its sender was not told. Google had
removed the `google` alias's model (Gemini 3.1 Pro) from the subscription's offered list. Older Gemini sessions
that still named a retired model had the same problem.

## Cause

Confirmed from the commits and docs. The Antigravity CLI rejected the retired model with a structured result
(status ERROR, zero turns, zero tokens) before emitting `init`. `runAntigravityTurn` in `bot/src/antigravity.ts`
treated every missing `init` as an ambiguous run, so the request waited instead of failing. Even when it failed,
the request owner was only reconciled on output events, not on a provider terminal fact (`turnFactChanged` in
`bot/src/state.ts`). Separately, `executeAgentTurn` in `bot/src/turn-execution.ts` fed the refusal into the
account-wide provider retry breaker, so one session's invalid model described healthy Google work as down.

## Fix

- 90e656ed: `google` alias now selects `gemini-3.8-flash-high`, the highest mode `agy models` listed on 2026-10-13
  (old id kept as retired). A refusal with no init, status ERROR, zero turns, zero tokens, no output and no tools
  is a confirmed failed start (`ProviderDispatchError` with `terminalConfirmed`). Every provider `terminal` fact now
  wakes request reconciliation so the sender sees the failure at once. A missing init without that zero-work proof
  stays unconfirmed.
- bbee3d28: a confirmed "invalid model selection" refusal with no output or tools is non-retryable and skips the
  account-wide breaker; the request fails with the provider's reason. An old session keeps its recorded model; no
  silent model change or replay. The audit was restarted in a fresh session.

## Acceptance scenario

- **Seed:** A Google session bound to a model the CLI no longer lists; a requester waiting on a request to it.
- **Action:** Send the request; the CLI returns the structured zero-turn, zero-token ERROR "invalid model selection"
  before init.
- **Expected:** The request settles failed with the provider's reason and the requester is told promptly; no Google
  account-wide breaker or outage notice is recorded; a separate healthy Google session still runs. A run that exits
  without init but with any output or token use stays unconfirmed, not failed.
- **Replayable offline:** yes (stub CLI emitting the structured refusal)
