# Grafana operational alerts

Concierge accepts only authenticated, allowlisted Grafana alerts. Firing creates a
provider-free native Inbox notice; recovery posts to and closes that same notice.
One native service-authored investigation turn is queued per firing episode, with
unfinished turns for the same condition coalesced. `ConciergeDegraded` is investigated
by the outside work-flow supervisor instead, so two repair agents do not race. Neither
path sends email or a Slack message. Older Slack alert receipts remain in the ledger
for provenance; new firing episodes move to native delivery.

The source of rule definitions, thresholds and resource dashboards is
`remote-box/observability/alerts.json`, `remote-box/observability/dashboard.json`,
and [its observability runbook](https://github.com/tejasdc/remote-box/blob/main/docs/observability.md).
This project owns the webhook parser, native receipt, Inbox notice and native
investigation admission. The retired Slack design remains in
[the historical plan](../plans/2026-09-15-grafana-machine-alerts.md), not the
current delivery contract.

## Contact and acceptance

- Grafana contact: `personal-observability-concierge`, UI-editable webhook POST to
  `https://95-217-119-40.sslip.io/alerts/grafana`, with native Grafana JSON and
  resolved messages enabled.
- Authorization: bearer value from `/etc/concierge/grafana-alerts.token`, never in
  the URL or logs. `bun bot/scripts/grafana-credential.ts` verifies or creates it
  from the existing private ingress credential. The receiver permits at most 64
  alerts and 256 KiB per request.
- `GRAFANA_CONDITIONS` in `bot/src/grafana-webhook.ts` is the exact condition
  allowlist. Adding or renaming a remote-box rule requires updating this allowlist
  in the same delivery. Unknown-only batches return 422; mixed batches report
  omitted unknowns. `AX41JournalNotRecording` and `YouTubeReadwiseStale` were
  previously omitted and silently failed at this boundary.
- A 202 means the alert was retained by the owner. It does **not** prove the
  notice was filed or an investigation started. Check `grafana_alert_delivered`,
  `grafana_alert_investigation`, the native Inbox item, and an actual queued or
  running investigation turn. When the owner is down, Grafana retains delivery
  failure; the independent box supervisor owns owner recovery.

Grafana's fingerprint and start timestamp define one episode. The owner rejects
stale firing after recovery, deduplicates deliveries, and keeps its receipt and
investigation link in the existing state backup. Native Inbox publication is
idempotent by episode key, so a process exit between publication and receipt
commit can retry safely. Resolved alerts settle the matching Inbox notice.
Other native shape fields are discarded: no labels, annotations, request bodies,
SQL text, logs or credentials enter the notice. The notice is information for
Tejas, not an instruction to the investigator.

## Diagnosis and repair

The service-authored investigation is a named Concierge session in the
`slack-concierge` project. It receives the allowlisted condition, opaque episode
identity and source, then reads retained evidence itself. It follows this
project's ordinary review, source and deployment ownership. It must coordinate
with any existing incident and cannot launch an independent repair loop or send
email. The outside supervisor owns responsive-owner memory and latency incidents,
including a retained evidence file, a bounded investigator and recovery notice.
Its monitoring runs even when the Concierge process cannot answer.

Do not treat a response from this webhook, a sent notification, source commit or
healthy service status as proof of repair. Verify the queued investigator's
execution and the actual condition's recovery, then report any remaining live
acceptance separately. A test alert uses `TestAlert` or
`ConciergeWebhookAcceptance`; those names create notice receipts but no agent.

The safe owner journal events are `grafana_webhook_completed`,
`grafana_alert_delivered`, `grafana_alert_investigation`, `grafana_alert_retry`,
`grafana_alert_parked`, and `grafana_alert_worker_failed`. Inspect the retained
fingerprint/status/revision/notice root/investigation turn and Grafana's exact
notification history; do not dump the bearer or private monitoring evidence.
