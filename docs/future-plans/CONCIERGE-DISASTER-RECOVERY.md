# Concierge disaster recovery

## Goal

Define an explicit recovery objective for Concierge, then create coherent
application snapshots and a restore procedure that does not blindly repeat
Slack, provider, filesystem, List, Canvas, or Git effects.

## Candidate sequence

1. Choose the recovery point objective, recovery time objective, and which
   external actions must be automatically replay-safe.
2. Replace raw live-SQLite copying with application-consistent snapshots of the
   main and capture databases; keep Restic as the storage transport.
3. Add a small generation catalog, retention, overdue alert, and a rehearsed
   offline restore runbook.
4. Inventory ambiguous external effects and add local intent/receipt records
   only where actual recovery drills demonstrate a need.
5. Consider Slack sentinels, exhaustive history reconciliation, or a universal
   effect registry only if the chosen recovery guarantee requires them.

## Why it is separate

Restore correctness is a whole-platform property. Treating it as a Pebble
dependency pulled provider execution, Monologue, project creation, Slack Lists,
Canvas, Git, and backup orchestration into a simple webhook.

The complete exploratory mechanics and threat analysis remain in
`2026-08-19-platform-hardening-source-design.md`.
