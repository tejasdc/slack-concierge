---
failure: A Codex side question could not resume the reusable saved fork while the App Server held its writer.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Codex's saved side copy kept an active writer

## What was seen

With the runner's transcript lookup repaired, a candidate worker created the saved native fork
for the marked conversation. Its question then failed with Codex's `thread-store conflict`: the
fork already had an active writer. The saved fork identity was present in the source account home;
the answer was empty.

## Cause

The persistent Codex App Server created and held the native fork. A separate `codex exec resume`
process tried to become the same thread's writer, even with its own turn marked ephemeral. The
provider refused the second writer.

## Fix

Keep the saved fork as the reusable final-answer snapshot. For each question, have `codex exec`
make an ephemeral fork from that snapshot and answer there in its read-only sandbox. The tested
provider command returned an answer and left the saved snapshot's identity unchanged.

## Acceptance scenario

- **Seed:** A marked Codex conversation has a saved native side-question fork.
- **Action:** Ask two side questions about it, including one while the main conversation is running.
- **Expected:** Each ephemeral question answers; the saved fork ID remains the same until a newer completed final answer.
- **Replayable offline:** no (the conflict and ephemeral fork behavior depend on the live Codex App Server).
