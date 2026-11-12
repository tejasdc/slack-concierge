---
failure: A marked message accepted during Pause stayed unsubmitted after Continue.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Marked accepted input stayed held after Continue

## What was seen

Observed on installed release `30091dda5e0dc48d1d2f43f6146e2d5b398fc803`
in disposable native Claude session `concierge:9503` on November 12, 2026.

The agent control changed only that session. The marked capture entrance accepted
input `71b9aeb2-54d5-4294-ba02-ff2afc33ac85` while it was paused. Its receipt
remained `INPUT_HELD`, without a run or acknowledgement, while comparison session
9506 completed request `4b20d61c-96b6-4789-b0a0-4115ce166273`.
Explicit Continue operation `e311caa8-1918-4391-9c55-20cb00830321` cleared
suspension but left the same accepted input unsubmitted. The input was not resent.

## Cause

Surface acceptance records an explicit queue intent for a paused message. Immediate
Continue dispatch visits null receipts only. Both the normal surface recovery scan
and its validator admitted marked-agent live/forwarded inputs but excluded their
queue intent. A fresh read-only GPT-6.1 Sol investigator confirmed the source defect
and compared the relevant installed source. The exact stored raw receipt was not
available through presentation; source tracing establishes the queue-intent shape,
while public receipts establish the stalled input, completed control, and no run.
Sanctioned bounded ledger reads found only the runner ledger, with zero target rows;
the documented owner ledger path was unavailable in this execution environment.
No alternate access, live-ledger write or credential operation was attempted.

## Fix

The correction admits verified marked-agent queue intent through the existing
recovery scan and validator, and Continue/Restore wakes that coordinator. It adds
no queue, worker, timer, store, input identity or retry delay. Existing guards still
reject terminal/uncertain state, Focus-review holds, missing explicit intent,
misbound agent source, and historical turn, steering or local/peer request custody.

## State card and falsifying check

- Entity and writer: one accepted input in its native session; Concierge admission
  remains the sole writer of its execution binding.
- Retry identity: the original accepted input and its stable action, never replacement
  words or another request. The existing unique accepted-input turn constraint remains.
- Acceptance ladder: retained receipt, queue binding, provider acknowledgement, final
  answer. A completed Continue control proves only suspension changed.
- Lifetime: retained queue intent survives updates; normal reconciliation releases it
  only while the session can send. Pause remains deliberate until explicit Continue.
- Old readers: receipt format and wire schema stay unchanged. Legacy missing intent
  remains uncertain; Focus-review holds keep their separate release boundary.
- Failure trace: accept while paused; commit intent; Continue reply succeeds; owner
  restarts; same input either gains one turn or remains explicitly unsubmitted.
- Falsifying sequence: the installed real probe above fails before this correction.
  After reviewed installation, observe that exact already-continued input gain one
  execution under the unchanged native UUID, recall its earlier synthetic fact,
  and report actual inherited account. Do not resend for a fresh receipt.

The correction is source-checked only until its installation and that live check.
Server and Mac acceptance, cross-account recall and exhaustion remain separate.

## Acceptance scenario

- **Seed:** One disposable native Claude conversation has an earlier synthetic fact; pause only it and accept one source-marked message through the agent entrance.
- **Action:** Complete work in a second disposable conversation, then explicitly Continue the first.
- **Expected:** The exact accepted message stays unsubmitted while paused and gains one execution after Continue under the same native conversation, retaining its earlier fact; the comparison and controller remain active. Reconciliation does not create a replacement input or duplicate execution.
- **Replayable offline:** no (real native provider continuation and installed custody are acceptance boundaries; source and isolated database checks alone do not establish them).
