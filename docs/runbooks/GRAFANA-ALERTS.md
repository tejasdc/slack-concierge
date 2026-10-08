# Grafana operational alerts

Authenticated allowlisted alerts are retained in the existing Grafana ledger. Health
work goes to the standing repair agent, never to a health thread in Tejas’s Inbox
[decision: repair-agent-before-tejas]. No email or Slack message is sent for a new native
alert. The old Slack design is historical reference only.

## One investigation owner

- Ordinary firing episodes create one `grafana_alert` repair notice. The existing
  repair-notice delivery batches it into the standing Repair agent session; Grafana
  never creates its own second native investigation session.
- Recovery before admission marks the retained notice resolved and excludes it from
  pending delivery. Recovery after admission adds one idempotent recovery fact to the
  same standing repair session. A repeated resolution creates no further input.
- `ConciergeDegraded` and `AX41ResourcePressure` remain exclusively with remote-box’s
  external work-flow supervisor. Their Grafana receipt is retained, but firing/recovery
  do not write a human notice or a competing repair notice. The external occurrence
  owns investigation, terminal handoff and the existing unsolved escalation path.
- Reserved `TestAlert` and `ConciergeWebhookAcceptance` are receipt-only: no human
  thread, repair notice, or investigator starts.

The external supervisor reads retained host pressure through `grafana_condition_state`
and merges its episode/revision into the existing degradation occurrence. Disk, inode
and host CPU pressure are covered even without owner/speech pressure. Unknown ledger
or local evidence cannot resolve an occurrence; resolved host pressure removes that
signal only. Late signals reach its terminal standing-repair handoff. Install the matching
remote-box supervisor before activating this receiver.

## Receipt and delivery contract

The contact `personal-observability-concierge` posts native Grafana JSON to
`https://95-217-119-40.sslip.io/alerts/grafana`, with resolved messages enabled. The bearer
comes from `/etc/concierge/grafana-alerts.token`; never expose it in argv, URLs or logs.
`bun bot/scripts/grafana-credential.ts` verifies the existing derived credential.
Ingress allows at most 64 alerts and 256 KiB. `GRAFANA_CONDITIONS` is the condition
allowlist and must agree with remote-box’s rules; unknown-only batches return 422.

Fingerprint plus start timestamp defines an episode. Duplicate delivery and stale firing
after recovery are fenced by the retained ledger. Repair publication is idempotent by
that same episode and status. `repair_notices.resolved_at_ms` is the cancellation/recovery
fact, not fabricated delivery; the Grafana ledger retains the condition history. New
native `root_ts` values are opaque receipt keys, not Slack timestamps or human messages.
A 202 proves retention only, not agent admission, execution, recovery or hosted delivery.

## Safe acceptance and diagnosis

Read the configured contact and rule-group using the existing remote-box provisioning
commands. Send the reserved acceptance condition through the authenticated entrance,
then recover that exact episode. Verify its native destination, delivered revisions and
zero repair/human side effects. This proves receipt transport only. Grafana’s own contact
notification history establishes the hosted leg separately.

A real ordinary condition must have its `repair_notices.delivered_input_id` linked to an
actual accepted input in the standing repair session. Verify that session’s execution
and the real condition’s recovery. A safe explicitly marked informational request to
that discovered session can verify addressed delivery without falsifying a health event.
Do not manufacture an outage or modify production observations to provoke repair.

Isolated coverage is in `grafana-repair-first.test.ts` and
`grafana-native-ownership.test.ts`: pending versus admitted recovery, repeated episodes,
no human thread, no competing native investigator, and all allowlisted conditions.
Inspect `grafana_webhook_completed`, `grafana_alert_delivered`,
`grafana_alert_investigation`, `repair_notices_delivered`, and retained owner/external
incident evidence. Event labels alone never prove repair succeeded.

Remote-box owns [rule definitions, collection and alert operations](https://github.com/tejasdc/remote-box/blob/main/docs/observability.md).
