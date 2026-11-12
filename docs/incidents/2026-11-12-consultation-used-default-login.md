---
failure: Information-only consultation copies used an expired default Claude login and requested sign-in for working accounts.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Consultation copies blamed working Claude accounts

## What was seen

On the server, consultation concierge:9480, Claude conversation
`c9f692db-bb31-4856-af14-2176a8ee6027`, failed at 19:48:58, 19:52:07 and 19:55:19 UTC
with the same ended-login refusal. Concierge requested renewal for tejas@chann.app and
hey@tejas.nyc even though their own login folders answered direct Claude requests.
The default folder held the ended login. Each false attribution sent the Mac browser
agent toward Chrome with unnecessary sign-in repair requests.

## Cause

Runner-bound turns intentionally carry an account label instead of an owner-local login
path. `turn-execution.ts` supplies `CONCIERGE_PROVIDER_ID` and `CONCIERGE_PROVIDER_ACCOUNT`;
the runner resolves that pair through `runnerAccountHome` before launching Claude.
`claudeConsultationEnvironment` retained local `CLAUDE_CONFIG_DIR` but discarded the runner
pair. With inheritance disabled and no selected home, Claude used the default login.
The refusal handler attributed the result to the intended account, producing false renewals.
The transcript folders share history, so finding the transcript there did not establish login.
The earlier Mac statistics-file repair and agent-shell runner-home resolver cover different
launch boundaries and did not repair consultations.

## Fix

Preserve the two selected runner identity fields alongside the selected local home through
the consultation allowlist. The runner's existing credential-verified home resolution now
receives the intended identity. Do not inherit the full environment, pass capability tokens,
replace the default login, or relax the no-tools policy. The existing release runner-account
check rejects loss of the identity fields and leakage of action or API credentials.

## Acceptance scenario

- **Seed:** A runner has an ended default Claude login and a working separately stored chosen
  account. A retained historical Claude source can create a consultation-only child.
- **Action:** Ask that source an information-only question through Concierge, allowing the
  ordinary dispatcher to select the account and the runner to resolve its home.
- **Expected:** The child answers under the chosen account, with tools disabled, without a
  sign-in renewal for that working account. The original held consultation either answers its
  asker or reports its exact final disposition; no ambiguous accepted input is replayed.
- **Replayable offline:** no (full proof needs a real authenticated Claude account and runner;
  the release check separately exercises the restricted environment boundary without secrets).
