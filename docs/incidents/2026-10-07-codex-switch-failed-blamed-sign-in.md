---
failure: Every Codex account switch from Oct 4 to Oct 7 failed, and Accounts blamed his sign-in instead of the real cause.
date: 2026-10-07
fix_commits: [30b77e25]
cause_status: confirmed
---

# Codex account switches failed and the page blamed the sign-in

## What was seen

From October 4 to October 7, 2026, every Codex account switch in Accounts failed with "Signed in, but this machine
did not pick the new account up", which read as a sign-in problem. Tejas's sign-ins were fine.

## Cause

Confirmed from the commit and `docs/architecture/PROVIDER-USAGE.md`. A Codex App Server listener started on Oct 4
outside its daemon manager refused `codex app-server daemon restart`, so `activateCodex`
(`bot/src/provider-activation.ts`) could never move the daemon onto the new account. Its failure branch reported
every restart failure with the same sign-in-sounding message, hiding the unmanaged listener.

## Fix

30b77e25: on a failed restart `activateCodex` checks `daemon version`; when the backend is not the managed one it
logs `provider_activation_failed` with `unmanaged: true` and says the background service was started outside its
manager and nothing was switched, otherwise that Codex could not be restarted; `restartFailed` marks the report.
The unmanaged listener itself was replaced by the managed daemon per `docs/runbooks/CODEX-APP-SERVER.md` (an
operational step, not code). The same commit's Accounts listing fixes are recorded in
[Codex account listed twice](2026-10-07-codex-account-listed-twice.md).

## Acceptance scenario

- **Seed:** a stub `codex` whose `app-server daemon restart` exits non-zero and whose `daemon version` output has no
  managed `"backend"` field; a second saved Codex account.
- **Action:** switch to the second account from Accounts.
- **Expected:** the switch fails with the "started outside its manager" message, the credential stays as it was,
  and the log shows `unmanaged: true`; with a managed stub the switch succeeds.
- **Replayable offline:** yes (stub `codex` binary on PATH; scratch account homes)
