---
failure: A Claude session killed after starting work failed its accepted request without continuing automatically.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Claude crash after a tool checkpoint left work failed

## What was seen

An independent server Codex controller killed only the native Claude process after
a readiness tool checkpoint. Request `a578143f-fa9c-43f6-902a-6034876db3e0`, session
9466, turn 28948, run `c4af9105-7e08-4b0d-a7bd-289606ed9a76`, execution
`adb3bbdfa7b1d033` returned a failure saying nothing would retry it. SIGKILL reached
Claude PID 3326101 at epoch 1794511588.6508236. The original request and killed
session remain unchanged as the before-fix counterexample.

The controller's source request is `e6d5ac31-751d-4312-ae46-37638cb4bfea`, session
9410. Its attached evidence is
`account-experiments-claude-crash-failure-20261112.md`; the repair request is
`eaa06fab-8243-4039-a167-2b13cc5bc292`, session 9467.

## Cause

The execution host retained the actual process exit. The Claude adapter discarded
that distinction by throwing a plain error for no terminal result. The turn
coordinator's worked-on interruption handling recognized Codex interruptions only,
so it failed the turn without admitting a continuation.

## Fix

Carry confirmed Claude exit evidence and observed work in the typed dispatch error.
Use the existing atomic failure/continuation transaction, queue, conversation and
one-interruption budget. Do not infer process death from generic error messages,
host silence or connection loss. Keep intentional Stop and cancellation custody,
and reject continuation after a declared outcome or settled exact request.
No startup scan reoffers earlier crashes.

### State card

- **Entity/writer:** the accepted turn and its session, written by Concierge's
  existing ledger coordinator; no additional queue, worker or schema.
- **Identity:** the failed turn remains history; `turn-continuation:<turn>` is a
  unique service input linked to the source input/run, in the same conversation.
- **Acceptance:** retained process exit proves death; atomic failure plus service
  admission proves queued recovery; only the independent live retest proves the
  provider resumed, remembered prior work and answered the original request.
- **Retained state:** original prompt, native transcript, prior effects and exact
  communication request survive. A continuation carries new guidance, not a replay.
- **Lifetime/readers:** existing host journal survives Concierge restart and
  existing queue launches recovery. Existing carrying-turn readers follow it.
  No wire or schema change; older running hosts retain the same exit frames.
- **Failure trace:** accept request → readiness tool acts → Claude dies before
  result → retain exit and admit one continuation atomically → inspect history,
  finish the original request once. An uncertain effect remains uncertain.
- **Falsifying sequence:** the fresh independent live acceptance below fails if
  no continuation starts, the barrier repeats, the remembered fact is lost, or the
  request gets more than one final disposition.

## Acceptance scenario

- **Seed:** a fresh disposable real Claude session through the source-bound ask
  entrance, with a remembered fact and a first-attempt-only readiness barrier in
  owned scratch space. A separate Codex controller records exact request/run,
  native conversation, execution, PID and cgroup identities.
- **Action:** after readiness, kill only that verified Claude PID. Never resume,
  resend or edit the killed request manually.
- **Expected:** the original request stays open through one automatically queued
  service continuation, the same conversation recalls the fact, the readiness
  action occurs once, and one final reply settles the original request. Stop,
  archive, withdrawn authority, a live/unreachable host, ambiguous effect outcomes,
  a declared result and an interrupted continuation remain protected.
- **Replayable offline:** no; the acceptance is a real hosted Claude process
  interruption against an installed release. Unit suites are disabled in this
  project. The independent controller owns the fresh live retest after installation.

## Installed server acceptance — independent controller

After installed merge `c6aaaffedebf6ff4747c64eef8266a82a9ba8409` was confirmed,
the separate Codex controller ran fresh real request
`6d898287-b3e9-4f40-9114-b442494ff856` in Claude session `9476`.
It killed only the verified native Claude child after the readiness checkpoint.
The same conversation `fd3613cb-df78-47c4-9d62-e4ad2cc04bb4` automatically
received `turn-continuation:28991`, retained the remembered fact, and completed
the original request once on turn `29005`. The transcript contains one original
request header and one continuation header; the barrier invocation log contains
one entry. No manual resume or original-input resend occurred.

A second fresh request `d41fa95e-e0aa-416e-8363-119f4d96ea36` had cancellation
confirmed before its verified native Claude process was killed. Its provider
execution failed while its request stayed cancelled, with no continuation,
active run or queued work. A separate cancellation-only control also remained
cancelled. These are server observations; Mac installation/execution, human Stop,
archive and repeated-crash budget are not claimed as additional live checks.

The controller's [experiment report](../experiments/2026-11-12-account-switching.md)
and [machine trace](../experiments/2026-11-12-crash-recovery-acceptance.json)
retain the exact identities, assertions and process-layer distinction between
the injected native-child SIGKILL and the enclosing launcher's observed exit 143.
