---
failure: A server Claude sign-in repair stayed queued even after the Mac came online because the Mac rejected its bundled repair notice source.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# The Mac refused a valid bundled sign-in repair

## What was seen

The server's saved Claude accounts were unreadable while the Inbox was bound to Codex. Concierge recorded a Claude sign-in repair for the Mac browser worker. The request retained its original identity in `queued_offline` after the Mac came online. Its exact peer admission event reported that Mac work lacked a valid machine need, even though the request carried the internal provider-renewal need.

## Cause

The server grouped several repair notices into one admitted input, named for the first notice. The Claude sign-in repair was one of the later notices, so its peer request carried a different repair-notice input ID. The Mac's private provider-renewal gate allowed only an input ID naming the sign-in notice itself and rejected the valid batch. Retrying the same request repeated that rejection.

## Fix

The Mac accepts the internal provider-renewal need from any owner-generated repair-notice input when it arrives over the authenticated peer channel at the fixed provider sign-in worker. Ordinary agent machine-need parsing still refuses this private need. The original peer request keeps its identity and is retried by the existing reconciliation path after the Mac installs the change; no replacement request is created.

## Acceptance scenario

- **Seed:** Several server repair notices are batched, with a Claude sign-in notice after a different first notice. The server's same peer request has the internal provider-renewal need and the fixed Mac worker address.
- **Action:** The Mac admits that request after reconnecting.
- **Expected:** It accepts the bundled repair-notice provenance and delivers the existing request to the browser worker. An ordinary agent request with a claimed provider-renewal need or a different target remains refused.
- **Replayable offline:** the peer admission decision is replayable; completing the actual browser sign-in depends on the live saved account.
