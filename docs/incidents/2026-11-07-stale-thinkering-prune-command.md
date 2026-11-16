---
failure: A managed agent ran a stale checkout's Thinkering prune script and removed recent diagnostic releases.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Stale Thinkering cleanup command crossed the release authority

## What was seen

An agent ran Thinkering's cleanup command from its dirty source checkout at
`54afdbda`. That checkout predates the installed retention rules. Its root
process removed release `58eada` with three failed diagnostic runs younger than
48 hours. The incident packet is retained with request
`eb99a3ae-ff54-4288-9f1e-11f304cfdd7e`; the recoverability of those runs is
unknown.

## Cause

The old script retained root filesystem authority after a newer Thinkering
release installed. The invoking checkout, rather than the installed policy,
selected what to remove. Thinkering now pins its retention authority separately
from the current app release, preserving it across rollback.

## Fix

Concierge's managed command preflight adds a second boundary before a shell command starts: direct
checkout prune, activation, rollback and policy upgrade are refused, because each
can invoke retention. The installed entrance must match the policy pin. Direct
deployment-module calls are also refused because they bypass the wrapper's
release lock. Normal `npm run ship` continues to call Thinkering's own controller.

The preflight applies to managed agent tool calls. An already-running root script,
an internal call from old application code, or arbitrary root execution outside
the managed command entrance cannot be stopped by this hook. Thinkering's pin
handles its updated controller; the root bypass remains an explicit limit.

## Acceptance scenario

- **Seed:** Current installed Thinkering release has a verified policy pin; an
  agent's working directory is an older checkout.
- **Action:** The agent requests direct checkout prune, activation, rollback
  and policy upgrade, direct deployment-module calls for those actions, and
  the installed entrance as separate shell calls.
- **Expected:** The stale and direct-module calls are refused before execution. The installed
  entrance passes preflight only while current resolves to the pinned release.
  `npm run ship` remains available. No proof runs cleanup itself.
- **Replayable offline:** yes for command parsing; pin matching requires a
  read-only installed filesystem view.
