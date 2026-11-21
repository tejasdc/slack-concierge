---
failure: A Lab model choice could authorize a subagent or a different group using the same Codex session.
date: 2026-11-21
fix_commits: []
cause_status: confirmed
---

# Keep the Lab's Astra authority with the selected membership

## What was seen

After the repair for the failed storytelling voice, an isolated comparison proved that
its retained selection also admitted an Astra prompt from a provider subagent.

## Cause

The shared model gate looked up the latest matching model selection for the Codex
session. That lookup did not bind the decision to the membership that selected
the participant, and the gate did not distinguish a provider subagent.

## Fix

Resolve the selected voice from the exact activation and follow its retained membership
to the choice recorded when that voice joined. Preserve it across unrelated roster
revisions in the same Lab. Refuse missing authority and provider subagents without
substituting a model. Record distinct prompt refusal reasons independently per attempt.

## Acceptance scenario

- **Seed:** Choose a fresh Astra voice in one Lab, then keep it while adding a different voice.
- **Action:** Ask the selected participant, ask a provider subagent, and reuse the selected session in another Lab.
- **Expected:** The original membership still admits its own invocation. The subagent
  and different group's unproven selection are refused. Distinct denials are recorded
  without colliding, and no replacement is sent.
- **Replayable offline:** yes (`bun run scripts/astra-dispatch-substitution-fixture.ts`)
