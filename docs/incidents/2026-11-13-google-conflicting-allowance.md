---
failure: Google's quota disagreement notice claimed room without retaining the meter and account evidence.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Google quota disagreement evidence

## What was seen

Original service notice `repair-notice:usage-reading-disagrees:antigravity:2026-11-13`:

> Google refused a turn for quota ("Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h18m26s.") while Concierge's own Google allowance reading shows room. Find which allowance Google is enforcing and make the reading show it.

Accepted recovery input `recovery:repair-notice:usage-reading-disagrees:antigravity:2026-11-13`,
run `8b02cef4-7b78-4d90-9ae4-9ad0d0764e44`, session `concierge:9640`.
This is a service-origin repair request, not newly authored human instruction.

The same account had exhausted Gemini weekly/reset02:15:16Z at22:57:06Z, then
approximately1% used at22:57:59Z. Direct zero-token CLI metadata at22:59:33Z again
reported exhaustion. Argon had a separate reset. Actual Flash refusals corroborated
the earlier Gemini reset duration, but did not establish its continued validity.

Native hold release occurred23:17:42Z. The parent's bounded tools-denied,
paid-credits-disabled exact Flash check at approximately23:20Z returned SUCCESS/READY,
one turn,8755tokens. Session9305 resumed through the normal owner. The live health
receipt is `/tmp/repair-google-flash-health.json`; this is local incident evidence,
not a portable release dependency. Approximately1% used and actual admission now agree.

## Cause

Confirmed diagnostic defect: the notice always said the reading showed room whenever
no reset was accepted, even if the reading was unavailable or an exhausted meter lacked
a usable reset. It omitted selected account/model/runner, refusal time and the actual
post-refusal snapshot. The upstream alternating meter cause remains unknown. Refresh
cancellation occurs with both result categories and does not identify the cause.

## Fix

Preserve native meter/admission/reset/recovery behavior and improve the existing notice's
evidence and classification. An earlier candidate retaining full windows until original
reset was never shipped: live admission disproved it by showing recovery approximately
three hours before that reset. Source draft remains preserved outside the shipped change.
See [current diagnostics contract](../architecture/PROVIDER-USAGE.md#google-quota-disagreement-evidence).

## Acceptance scenario

- **Seed:** actual quota refusal context plus controlled post-refusal room, unavailable,
  stale, incomplete and exhausted-without-reset snapshots.
- **Action:** format the existing repair notice with the production pure formatter,
  then retain and render it through the real repair-notice functions in disposable SQLite.
- **Expected:** exact dispatch and post-refusal identities/times/windows/problems remain
  distinct; only fresh complete room is described as room; missing reset/read is unknown
  or exhausted as appropriate. Account/runner mismatch or unknown dispatch identity/model
  stays unavailable. The exact evidence survives stored repair-notice readback and delivery
  rendering, with normal deduplication/delivery custody. No provider request, production
  state write or admission decision occurs.
- **Replayable offline:** yes, `bun bot/scripts/google-quota-disagreement-fixture.ts`.

Local formatter checks do not prove a deployment. Live admission proves the incident
recovered through native behavior; installed diagnostic formatting needs separate release acceptance.
