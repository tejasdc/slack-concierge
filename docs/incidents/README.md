# Failure records

One file per distinct failure that Tejas, an agent or the running system actually hit and a
commit fixed. These records are the failure catalogue: the agent-native engineering experiment
replays their acceptance scenarios against evolved software (agent-ecology
`docs/research/2026-10-21-bug-history/acceptance-cases.json`).

Tejas, 2026-10-21: "hopefully we're capturing every single failure mode when it happens. So when
we run the experiments, we can look through all of these failure modes and use them as criteria to
see whether the evolved software removes any or all of them, and use them as test cases and test
scenarios."

## Every commit declares

Every commit carries one trailer line:

```text
Failure-record: docs/incidents/2026-10-21-what-went-wrong.md
Failure-record: none
```

A commit that fixes a failure names its record, written in the same commit or an earlier one.
Everything else says `none`. `.githooks/commit-msg` refuses a commit without the line, and the
GitHub release check refuses a branch whose commits lack it, so nothing reaches `main` undeclared
(`bot/scripts/failure-record-check.ts`). A pushed commit that missed its line is declared
afterwards, never by rewriting it: a later commit on the branch carries
`Failure-record-for: <hash> <record path | none>`, or the hash goes in a record's `fix_commits`.
A `none` whose message reads like a fix is flagged in the check's output, not refused: the author
knows whether the change fixed something, and a word list does not.

## Record format

Path: `docs/incidents/YYYY-MM-DD-<what-went-wrong>.md`. The check validates every file that has
front matter, and refuses a new file here without it.

```markdown
---
failure: <one sentence: what went wrong, in product words>
date: YYYY-MM-DD
fix_commits: [abcdef12, 34567890]   # may be [] in the fixing commit itself; its trailer links it
cause_status: confirmed | best-explanation
---

# <What the user saw>

## What was seen
## Cause
## Fix
## Acceptance scenario

- **Seed:** <state to set up>
- **Action:** <the one thing that happens>
- **Expected:** <observable result proving the failure is gone>
- **Replayable offline:** yes | no (<why>)
```

Older records in this folder predate the format and remain valid history. Larger write-ups that
cover several failures live in `docs/retrospectives/`; a trailer may name one of them too.
