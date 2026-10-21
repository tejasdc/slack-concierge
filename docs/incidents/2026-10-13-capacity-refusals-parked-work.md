---
failure: When OpenAI said a Codex model was overloaded or at capacity, Concierge marked the work failed or parked it instead of waiting or moving it to Claude.
date: 2026-10-13
fix_commits: [e34a306b, 5743725e, f76d6070, 73d8dce7]
cause_status: confirmed
---

# Work sent to a Codex model that was at capacity failed or sat parked

## What was seen

On 2026-10-13 three Codex (Sol) turns were reported failed; their Codex transcripts carry
`codex_error_info: server_overloaded` and no items. After the first fix the same kind of refusal parked the work
instead of failing it. On 2026-10-16 from 03:48 ET, OpenAI answered "Selected model is at capacity. Please try a
different model." and work was again marked failed, including an outside Codex run that read only as "Codex ended
with code 1", and the next Codex turn was refused outright.

## Cause

Three layers, each confirmed in the diffs and in docs/architecture/PROVIDER-SESSIONS.md:

1. Before e34a306b nothing typed the refusal: `codex.ts` built a plain `ProviderDispatchError` from the App Server's
   `TurnError`, ignoring `codexErrorInfo=serverOverloaded`, so it took the ordinary refusal path.
2. e34a306b remembered the refusal and moved an Automatic first turn only when the input was unacknowledged, and kept
   acknowledged capacity refusals parked. Codex accepts the turn and then ends it with `serverOverloaded` before the
   model does anything; all three Oct 13 turns had provider turn IDs and acknowledged-input timestamps, so the fix
   moved none and parked them all.
3. On Oct 16 the words "at capacity" were not recognised on every path. `outside-codex.ts` saw the refusal only on
   stderr (a resumed run's remote compaction died on it), counted the CLI's `error` items as tools, and so marked the
   run worked-on and the failure permanent. App Server capacity retries were recorded under the shared
   `provider:<id>:<account>` breaker key in `turn-execution.ts`; one turn's capacity retry and another turn's
   permanent failure exhausted it after two attempts in forty seconds, refusing every later Codex turn.

## Fix

- e34a306b: types `serverOverloaded` as `modelAtCapacity`, remembers the model for 20 minutes
  (`provider-model-capacity.ts`) so new Automatic work skips it, and moves an unreceived Automatic first turn.
- 5743725e: treats a confirmed-terminal refusal with no tools, output or artifacts as zero work (acknowledgement is
  not an effect), so an Automatic first turn moves to the provider with room and every other capacity refusal waits
  and retries instead of parking.
- f76d6070: `isModelCapacityRefusal` matches the words as well as the typed code for App Server and outside runs;
  outside runs read it from stderr and no longer count `error` items as tools; the wait uses the turn's own
  `provider-capacity` policy (30 s doubling to 10 min, twelve attempts, two hours) keyed by the turn; a worked-on turn
  gets a `rate_limit` continuation; the receipt says the model is at capacity.
- 73d8dce7: moves the matcher into import-free `model-capacity-refusal.ts`, because the presentation worker importing
  it from `provider-failures.ts` failed the release check and blocked f76d6070 from shipping.

## Acceptance scenario

- **Seed:** A Codex session (explicit model) and an Automatic Codex session with no earlier turns, Claude with room;
  a stub Codex that acknowledges each turn and ends it with `serverOverloaded` / "Selected model is at capacity", and
  a stub `codex exec` that prints the refusal only on stderr and exits 1.
- **Action:** Dispatch one input to each, plus an unrelated Codex turn that fails permanently at the same moment.
- **Expected:** The Automatic first turn moves to Claude with the same session, input and request IDs; the explicit
  and outside turns stay queued with a "model is at capacity" receipt and retry under `provider-capacity`; no input is
  marked failed or parked, and the unrelated failure does not stop the capacity waits or refuse later Codex turns.
- **Replayable offline:** yes (stub Codex App Server and CLI; no real OpenAI capacity episode needed)
