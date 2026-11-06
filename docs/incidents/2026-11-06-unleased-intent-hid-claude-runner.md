---
failure: A queued Claude continuation failed because an unleased launch intent hid the conversation's runner.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# A queued Claude continuation could not find its runner

## What was seen

The owner logged the same setup refusal for session 8945 at 06:43:38, 07:10:01 and
07:24:20 UTC. The last was turn 23953. An earlier owner drain at 06:43:10 withdrew
the runner job for turn 23814 before a runner claimed it. A different release drain
began at 07:24:23, after the last setup refusal. The retained report says the exact
runner lease was unavailable. The
authorized read-only owner-ledger query confirmed turn 23953 had no execution row or
runner job: setup failed before runner custody. Its accepted input was the fired watch
`watch:58f08cbd91c7:fired`, not a direct human instruction. Turn 23907 also failed with
no execution row. The preceding turn 23814 had a runner-supervised execution with no
runner attempt; turn 23697 completed with a recorded AX41 runner attempt. Session 8945
has no stored provider-runner binding. The Grafana reconciler request
`721ddbc0-4734-4b04-a746-775c45ed485c` remains admitted and open. A second
read-only owner-ledger query found provider input acknowledged at 06:11:03 UTC for
turn 23697. Turns 23814, 23907 and 23953 have no provider-input acknowledgment,
and no later turn for this session does. The 23814 runner job was created at
06:43:09.418 and withdrawn at 06:43:10.765 during the owner drain, before claim.
The owner then recorded the unsent turn as requeued at 06:43:11.242. Thus the
repaired lookup selects the AX41 execution from turn 23697.

## Cause

The legacy machine lookup selected the newest execution intent whether or not a runner had
claimed it or the provider had received its input. An unclaimed runner intent has no lease.
After one such setup attempt, later turns could select it instead of an older execution that
actually held the conversation. The owner ledger confirms the intervening no-attempt
execution never delivered provider input, whereas turn 23697 did so on AX41. The
newer failed intent therefore cannot displace AX41 as the last evidenced placement.
The first job was withdrawn by the 06:43 owner drain, an allowed interruption
before claim; the defect was letting that unclaimed record displace the established
AX41 placement. The 07:24 drain neither caused nor repaired the prior setup failures.

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
- **Failure trace:** Turn 23697 completed with an AX41 runner attempt. The 06:43 owner
  drain withdrew turn 23814's runner job before claim but left its execution record.
  Turns 23907 and 23953 failed setup without execution rows. The latter preceded a
  separate 07:24 release drain by three seconds.
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
