# Grafana operational alerts

Concierge owns bot-authored delivery and one bounded read-only investigation per
firing episode. Thinkering/remote-box owns the Grafana rules and contact. This
boundary never calls capture ingress, publishes with a user token, or sends email.

## Contact contract

- Name: `personal-observability-concierge`; integration: Webhook; method: POST.
- Keep the contact UI-editable: create it in Grafana's UI, or use the API with
  `X-Disable-Provenance: true` and verify editable provenance after creation.
- URL: `https://95-217-119-40.sslip.io/alerts/grafana` (existing TLS origin).
- Authorization Header Scheme: `Bearer`; Authorization Header Credentials:
  exact trimmed contents of `/etc/concierge/grafana-alerts.token`.
- Header: `Content-Type: application/json`.
- Native Grafana JSON; no custom payload/template required. Max Alerts: 64;
  Disable resolved message: **off**. Do not put credentials in URL parameters.
- Keep the default receiver empty. Route only the seven owned rules to this
  contact; configuring routing does not establish listener readiness.

The source must be `https://gracefulfennel1915.grafana.net` (one trailing slash is
also accepted). `alerts` must contain 1–64 instances; the streamed body limit is
256 KiB. Each known instance requires `status` (`firing` or `resolved`), its native
hex `fingerprint`, `startsAt`, and `labels.alertname`; resolved instances also
require `endsAt >= startsAt`. The envelope requires `status` and `externalURL`.
Other native fields are accepted and discarded. Timestamps are normalized to UTC.

Example native shape, with illustrative identity only:

```json
{
  "receiver": "personal-observability-concierge",
  "status": "firing",
  "externalURL": "https://gracefulfennel1915.grafana.net",
  "truncatedAlerts": 0,
  "alerts": [{
    "status": "firing",
    "labels": {"alertname": "TestAlert"},
    "fingerprint": "0123456789abcdef",
    "startsAt": "2026-09-15T06:00:00Z",
    "endsAt": "0001-01-01T00:00:00Z"
  }]
}
```

Recovery retains fingerprint/startsAt, changes both statuses to `resolved`, and
sets a real endsAt. Grafana generates these fields; operators must not replace
the native fingerprint with a condition name or a delivery/request ID.

Allowed conditions: `ThinkeringExternalUnavailable`, `ThinkeringBackupStale`,
`AX41ResourcePressure`, `ThinkeringDurableBacklogStale`,
`AX41CollectionUnavailable`, `AX41LogCollectionStalled`,
`PersonalTelemetryAllowance`. `TestAlert` and `ConciergeWebhookAcceptance` are
notification-only acceptance names and never start investigations.

Unknown conditions in a mixed batch are skipped and included with Grafana's
`truncatedAlerts` in the visible omitted count; none known returns 422. Malformed
known identities reject the envelope atomically. Return codes: 202 after durable
bot acceptance; 401 bad bearer; 413 oversized; 415 non-JSON; 422 invalid envelope;
503 bot unavailable/draining. A 202 receipt includes per-instance current state,
duplicate, delivery_status, channel, confirmed message_ts if available, and
investigation_turn_id. Acceptance is not confirmed Slack delivery. Receipt state
`parked` requires inspection; resending must not create another notification.

## Private credential handoff

From a reviewed checkout on the executing host, run:

```bash
bun bot/scripts/grafana-credential.ts
```

This exclusively creates or verifies the root-private 0600 file above. It derives
a dedicated HMAC bearer from `/etc/concierge/capture-queue.token` using the fixed
`slack-concierge:grafana-alerts:v1` domain. Neither the queue key nor a Slack
credential goes to Grafana. Ingress already receives the queue key as a private
systemd credential; no unit edit or additional credential loader is needed.
The Grafana operator reads the output file directly on this host and supplies
the value only to Grafana's secure authorization field. No secret value belongs
in chat, source, logs, shell arguments, or test artifacts. A differing existing
file is refused: coordinate queue-key rotation and Grafana field replacement.

## Delivery, investigation, and diagnosis

The public unprivileged listener forwards normalized data to the existing bot
loopback control listener, authenticated with the private queue credential. The
edge owns no Slack credential or alert queue. If the bot is unavailable, Grafana
retains the delivery failure and owns notification retries. A host-wide outage
also prevents this same-host receiver from delivering until recovery; inspect
the externally evaluated Grafana alert and notification history in that case.

Production roots appear in Thinkering channel `C0C03E75160`, authored by the
Concierge bot, with `Grafana · FIRING/RESOLVED`, condition, fingerprint, episode
start/recovery time, and an explicit machine marker. One current SQLite row and
one updated Slack root are retained per fingerprint. A recurrence updates that
existing root; it does not create a fresh top-level notification. Its new firing
episode can still start the bounded investigation described below. Stale episodes and late
firing after recovery cannot regress state. No raw labels, annotations, logs,
or request payloads are stored.

Existing durable native turn admission owns investigations, uses the channel's
configured provider/cwd/session mode and operator identity `U09ESSV1468`, and
records `turn_kind=machine_alert`. There are no synthetic Slack user claims.
There is at most one unfinished investigation per condition (seven total);
overlapping instances/episodes coalesce, and duplicates/resolutions do not
start work. Terminal failure does not automatically retry. Native Stop applies.
The fixed prompt permits a bounded read-only current-state/runbook investigation
and a proposed recovery with an owner; it does not authorize changes, delegation,
polling, or email. Real remediation remains an explicit operator decision.

The `grafana_alerts` table in the existing Concierge state database is the durable
receipt. Safe journald events are `grafana_webhook_completed`,
`grafana_alert_delivered`, `grafana_alert_investigation`, `grafana_alert_retry`,
`grafana_alert_parked`, and `grafana_alert_worker_failed`. Inspect fingerprint,
status/revision, root_ts, delivery_status/error, and investigation_turn_id, then
join the latter to native `turns`. Inspect Grafana notification failures at the
contact and state/history on the exact alert. Do not dump credentials or private
monitoring evidence into application logs. Rows persist with the existing state
backup; no additional episode history or retention scheduler is introduced.

Ambiguous first Slack posts park, including dead-owner sends without a confirmed
root. Known-root updates may retry transient failures, up to three attempts.
Only explicit rate-limit rejection can retry a first post. Slack's `Retry-After`
is retained in the durable receipt and pauses alert delivery across new arrivals
and restarts. Pending known work
resumes on startup; there is no idle polling. Parked delivery requires inspecting
the exact Slack/DB evidence before an operator repair; never delete its identity
or blindly post again.

## Acceptance and activation ownership

Claim a four-lane sandbox with the exact source and the provider transport fixture:

```bash
CONCIERGE_CLAUDE_CODE_EXECUTABLE="$PWD/bot/tests/sandbox/support/grafana-provider.py" \
  bot/scripts/sandbox-lane-control.sh claim --owner "<thread>" \
  --requester "grafana-alerts" --label "grafana-alerts" --worktree "$PWD"
bun bot/tests/sandbox/runner.ts execute grafana-alerts --lane lane-N --run-id <id> --apply
```

The claimed public sibling is `http://127.0.0.1:818N/alerts/grafana` for lanes
1–4; its route credential is the run-private
`state/capture-credentials/grafana-alerts.token`. This URL is host-local and is
**not reachable by Grafana Cloud**. Do not put the production contact against it.
The case uses native-shaped JSON through both HTTP hops, real lane bot delivery,
firing/recovery on one root, duplicate/auth rejection, notification-only
TestAlert, native provider-queue dispatch with a protocol fixture, screenshots,
zero new user/capture claims, and zero unsettled work. It proves transport and
orchestration; it is not a native Grafana Cloud TestAlert or real investigation.

Push `origin/main` only after exact-source sandbox acceptance, review corrections,
and the final gate. The existing signed GitHub push receipt and detached
deployment worker own the desired SHA, activation, runtime health, and repair.
Both this feature turn and any active parent turn must end before its idle
deployment boundary can win. Do not add polling, timers, completion wakes, or
provider restarts. The native release reactions are the completion handoff.

After native runtime health, a later user-initiated acceptance turn verifies
the destination channel registry still names the intended provider and code path,
then checks
POST routing (missing bearer must return 401), then sends Grafana's native
TestAlert. Verify its exact bot root and durable receipt. For firing/recovery,
use the notification-only `ConciergeWebhookAcceptance` native rule, restore it,
and verify the same fingerprint/startsAt root becomes resolved; remove the test
rule afterward. Only then claim delivery active for the seven owned conditions.
Normal rule evaluation and configured receiver settings alone are insufficient.
