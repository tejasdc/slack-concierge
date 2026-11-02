---
failure: Renaming one Inbox thread froze Concierge for 26 seconds, because the check for whether Tejas had named it read every thread event in the ledger.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# "Concierge is slowing down" after an agent renamed a thread

## What was seen

At 02:05:04 ET on November 2 an agent's `topic-rename` of `topic:fffb4904-…` took 26,544 ms
(`inbox_topic_mutation_slow`: compute 26,542 ms, retain 1, record 1). The owner event loop was held
26,419 ms (`owner_event_loop_lag`, cpu 5,728 ms) by one statement, fingerprint `adc1419d1fcd38a1`,
called from the topics route through `agentMutation`, and the outside monitor raised
`owner_loop_blocked`. The same statement had taken 1,049 ms at 23:52 ET the night before.

## Cause

The fingerprint is the SHA-256 prefix of the rename-author lookup in `session-topics.ts`
(`lastRenameBy`), hashed from the installed release bundle. Before a rename it asks whether Tejas
named the thread, by finding the topic's latest `renamed` event. The query filtered on
`kind='topic'` and the JSON topic id but not on the Inbox session, so no index applied: SQLite walked
every `session_owner_events` row from the newest backwards (the 6.3 GB ledger) parsing JSON, inside
the rename's owner transaction. Processor time was a fifth of wall time, so most of the 26 s was
reading ledger pages from disk. The thread-drift reader had a session-scoped copy of the same lookup
that still walked every Inbox topic event (~330 ms).

## Fix

One lookup, scoped to the topic's own events through the existing
`session_owner_events_topic_relation` index (session, topic id, sequence), named with `INDEXED BY`
because the ledger has no planner statistics. Bun's planner reports
`SEARCH … USING INDEX session_owner_events_topic_relation (session_id=? AND <expr>=?)` with no sort.
The drift reader now uses the same function.

## Acceptance scenario

- **Seed:** a ledger with many topic events across many threads, one Inbox thread with a human rename.
- **Action:** an agent renames a different thread, then that one without `human-approved`.
- **Expected:** each rename's slow-mutation record (if any) shows compute well under a second, no
  `owner_event_loop_lag` names fingerprint of the rename-author lookup, and the second rename is
  still refused with `TOPIC_TITLE_HUMAN`.
- **Replayable offline:** yes (plan check with `bun:sqlite`; timing needs a ledger of realistic size).
