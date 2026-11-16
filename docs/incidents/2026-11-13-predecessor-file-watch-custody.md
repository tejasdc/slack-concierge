---
failure: An agent continuing recovered work could not inspect or quietly retire its predecessor's redundant one-shot connection watch.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Predecessor file-watch custody after provider recovery

## What was seen

The recovered Spotify coordinator registered a renewing connection watch while its
predecessor's one-shot watch was not visible in its ordinary watch list. Both the
coordinator and Inbox received the expected “No such watch for this session” refusal
when trying ordinary cancellation. That refusal established an access boundary, not
the absence of the old watch. Production state remains uninspected by this implementation.

## Cause

Ordinary watch list/cancel deliberately use the registering session. Renewing takeover
searches only existing renewing watches; it cannot absorb a predecessor's one-shot watch.
The owner had no bounded operation proving exact recovery custody and retained work
delegation before quietly reconciling the selected pair. A common human input would be
the wrong proof: these two registrations originated under different human inputs.

## Fix

Separate exact-pair inspection and stable-action reconciliation prove the retained
recovery ancestor and complete all-work delegation, including the Inbox hops. Recovery
can retarget a canonical request to the recovered input; validation follows its exact
retained recovery edge and still checks the original source turn/run and work scope.
An immediate SQLite transaction quietly retires only the active redundant old watch or
its active series successor and records the operation receipt atomically. Terminal
history, accepted inputs and successor watch state remain unchanged. Ordinary list and
cancel retain their privacy boundary. Current contract: [durable watches](../architecture/WATCHES.md#exact-pair-recovery-custody).

## Acceptance scenario

- **Seed:** predecessor one-shot file watch, verified provider recovery continuation,
  existing renewing successor watch on the identical condition/machine, retained work
  delegation through Inbox and a designing session. Use different original human inputs.
- **Action:** inspect the selected pair, reconcile with the returned inspection and a
  stable action, lose the response, reopen storage and retry identically.
- **Expected:** one active match remains, the successor is unchanged, the receipt is
  identical, and no cancellation input, notification, rearm or product effect is created.
  A terminal pending/accepted firing stays byte-identical. Informational/unrelated chains,
  missing recovery links, mismatches, changed inspection and conflicting retries refuse.
  A receipt insertion failure rolls retirement back. A fired old renewing series retires
  only its active successor, preserving the original terminal event.
- **Replayable offline:** yes, `bun run scripts/watch-custody-fixture.ts` from `bot/`, with
  disposable SQLite and no account/path/provider access. This proves storage and command
  parsing only. Independent review and installed owner acceptance remain with the designer.
