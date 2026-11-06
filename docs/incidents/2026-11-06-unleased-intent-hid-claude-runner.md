---
failure: A queued Claude continuation failed because an unleased launch intent hid the conversation's runner.
date: 2026-11-06
fix_commits: []
cause_status: best-explanation
---

# A queued Claude continuation could not find its runner

## What was seen

The owner logged the same setup refusal for session 8945 at 06:43:38, 07:10:01 and
07:24:20 UTC. The last was turn 23953. The separate release drain began at 07:24:23 UTC,
after that refusal. The retained report says the exact runner lease was unavailable. The
owner ledger was not reachable from the investigating runner shell, so the exact predecessor
execution rows and this turn's final request disposition remain to be confirmed from the owner.

## Cause

The legacy machine lookup selected the newest execution intent whether or not a runner had
claimed it or the provider had received its input. An unclaimed runner intent has no lease.
After one such setup attempt, later turns could select it instead of an older execution that
actually held the conversation. That source defect explains the repeated error; the exact
first unleased intent in session 8945 is not yet confirmed from its ledger rows.

## Fix

For a legacy session, both turn dispatch and project location use the newest execution with
provider-acknowledged input. Its runner lease identifies the machine. Dispatch saves that
recovered binding before starting another host. When the acknowledged execution's lease is
missing, the owner continues to refuse a guessed machine. A focused build check covers an
unclaimed trailing intent, a claimed but unsent attempt, a later local execution, and
incomplete acknowledged custody.

## State card

- **Entity and writer:** The session's provider conversation and its machine binding belong to
  the Concierge owner ledger; the owner is the single writer.
- **Identity:** Session identity, provider UUID and each execution ID survive retries and owner
  restarts. A later dispatch intent does not rebind the existing UUID.
- **Acceptance:** An execution intent records a proposed launch; a lease records runner custody;
  provider input acknowledgment proves the conversation was used there. Only the last rung
  determines a legacy conversation's machine.
- **Retained state and lifetime:** Failed turns and their accepted inputs remain in the owner
  ledger. The runner may outlive an owner release; a new owner reads the same binding.
- **Old readers:** No schema or wire record changes. The existing session metadata field holds
  the recovered binding.
- **Failure trace:** The conversation ran on one machine; a later unclaimed runner intent was
  recorded; setup failed; another queued turn looked at that newer intent; its missing lease
  failed setup again before the release drain.
- **Falsifying check:** `bot/scripts/runner-lease-check.ts` would fail on the old
  latest-intent lookup and passes when acknowledged custody wins.

## Acceptance scenario

- **Seed:** A legacy Claude conversation has an acknowledged runner execution and a newer
  unclaimed execution intent with no runner attempt.
- **Action:** A queued continuation selects its machine.
- **Expected:** It selects the acknowledged runner, saves the binding, and can continue on
  that machine. If the acknowledged execution itself has no lease, it refuses a guess and
  leaves the accepted input visible for recovery.
- **Replayable offline:** yes (the lookup and negative cases); installed continuation needs
  an owner ledger and runner.
