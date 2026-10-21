---
failure: A side question on the Mac ran on a Claude account already at its weekly limit while the other account had 95% left, and he was told only "Claude could not answer".
date: 2026-10-14
fix_commits: [0fb5b205]
cause_status: confirmed
---

# Side question failed on a spent account while another had room

## What was seen

On 2026-10-14 Tejas asked a side question about a session on his Mac. The panel said only "Claude could not answer the
side question." The Mac's copy had run on `tejas@chann.app`, which was at its weekly limit, while
`tejastej.dc@gmail.com` had 95% of its week left. Nothing told him the cause was an allowance or that another account
could have answered.

## Cause

`claudeAside` in `bot/src/session-asides.ts` set `CLAUDE_CONFIG_DIR` from `selectedClaudeHome()`, the account he had
selected (or the main folder's login), regardless of its allowance. Ordinary turns choose their account through
`chooseClaudeDispatch` in `provider-account-dispatch.ts`, which passes over a spent account; side questions bypassed
that choice. When the copy then reported its limit, `claudeAnswer` logged Claude's words and returned the generic
"Claude could not answer" sentence.

## Fix

0fb5b205:
- `claudeAsideAccount()` calls `chooseClaudeDispatch(null)`, so a side question runs on the same account an ordinary
  turn would use now, skipping one out of allowance.
- When every account is out (`parked_terminal`), it answers "Every Claude account on this machine is out of its
  allowance until <time>…", and any other dispatch refusal is named.
- If Claude itself reports a limit anyway, its sentence is passed on ("…is out of its allowance (<Claude's
  words>)…") instead of the generic failure.

## Acceptance scenario

- **Seed:** A machine with two Claude homes: account A selected with a fresh usage reading at 100% of its weekly
  window, account B with 5% used; a stub `claude` that answers and records `CLAUDE_CONFIG_DIR`.
- **Action:** Ask a side question about a Claude session.
- **Expected:** The copy runs with account B's home and returns its answer. With both accounts at 100%, the reply
  names that every account is out and when the first frees up; no "Claude could not answer" text appears.
- **Replayable offline:** yes (seeded usage readings and a stub CLI; no real accounts needed)
