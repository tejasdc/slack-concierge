---
failure: The phone repeatedly showed 409 for three commands the session owner had already accepted.
date: 2026-10-24
fix_commits: []
cause_status: confirmed
---

# Phone retried delivered actions at released slots

## What was seen

At 02:02 UTC on October 24, the physical iPhone shell uploaded a census of three
IndexedDB commands in the `concierge:3172` stream. The same page immediately logged
repeated 409 responses from session input admission. Those three action IDs were
already in Concierge's independent capture store as delivered on October 16 at
sequences 206, 208 and 209. The phone retried them at 207, 214 and 215.

The October 23 four-send incident remains separate. Four UUIDs initially treated
as action IDs came from HTTP request timing diagnostics; that field identifies a
diagnostic span, so their absence from the command store says nothing about the
sends' custody. The four Thinkering request IDs supplied by the incident report
did not appear in command rows in the bounded snapshot, but their relationship to
the browser's command action IDs and to owner receipts has not been established.
This phone census contains only the three older actions, and this repair does not
assert custody or loss for the four newer sends.

## Cause

An earlier gap repair marked 207, 214 and 215 as missing so later original commands
could continue. The phone's retained commands now place already delivered action
IDs at those released sequences. Ingress refused them because its action identity
included sequence. The new conflict records show `action_changed` with only
`sequence` changed for each of the three actions, 17 attempts apiece at snapshot
time. Their body, client, stream, door, method and target match the delivered rows.

The command stream is ordered by Concierge ingress, its sole writer. The action ID
survives device and network retries. Device storage, ingress custody and owner
delivery are separate rungs; only the owner-delivered row allows this response.
If the receipt is lost again, the same action returns the same delivered receipt
and the browser clears its local copy without a second owner input.

## Fix

Ingress returns the existing delivered action receipt when every effect field
matches and the retried sequence is an audited, still empty missing slot. It
stores no second command, does not fill the released slot, and logs both sequence
positions. A changed body or an unreleased sequence still receives 409. This is
compatible with the installed phone page's existing behavior: a delivered receipt
removes its local retry by action ID.

## Acceptance scenario

- **Seed:** Retain one owner-delivered action in a scratch capture store and mark a later empty sequence in the same client and stream as an audited missing slot.
- **Action:** Submit the same action, body and target at that missing sequence through the real ingress handler.
- **Expected:** Ingress returns the original delivered receipt; exactly one command row and the original missing-slot marker remain. Changing the body or retrying at an unreleased sequence returns 409.
- **Replayable offline:** yes.

Live acceptance additionally requires the phone's ordinary retry to clear these
three IndexedDB commands without any second accepted owner input. Until that is
observed, source and scratch ingress checks do not prove device recovery.

## Follow-on: saved cards survived the old phone build

At 06:49 UTC the phone received the three original delivered receipts at the
audited empty slots. At 07:50 UTC a newer phone page nevertheless reported three
failed localStorage send cards for those same actions and retried them at new
sequences 312–314. Ingress correctly refused those attempts: the stored original
actions are delivered at 206, 208 and 209, while 312–314 are neither commands nor
audited gaps. The stream head is 312, so a later ordinary send would wait behind
these empty positions. The exact old-device storage transaction was not observed;
the build chronology and separate journal/card behavior support the explanation
that the old build settled its IndexedDB retry without clearing its failed card.

The owner operation receipt does not carry the original browser envelope or a
digest of the originally retained body, so the client cannot safely retire a
saved card by comparing that receipt alone. The authenticated command-status read
now projects the original ingress envelope and a SHA-256 of its stored JSON body.
This is a read-only identity proof for the client repair. It does not accept the
new sequence, fill 312–314, release a missing slot or prove the October 23 four
HTTP refusals were four distinct sends. Continuing the stream requires exact
device custody and an audited gap release after a genuine later command waits.
