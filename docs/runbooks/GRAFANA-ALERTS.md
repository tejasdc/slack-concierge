# Grafana operational alerts

Concierge owns bot-authored delivery and one native operator task per firing
episode. Agents diagnose, repair, verify, and improve demonstrated instrumentation
defects under [Tejas's standing authority](https://tejazz.slack.com/archives/C0C03E75160/p1789455922449049).
Thinkering/remote-box owns the Grafana rules and contact. This
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
start/recovery time, and an explicit machine marker. One updated Slack root is
retained per condition, with a separate current SQLite receipt row for each
native fingerprint. A recurrence or changed fingerprint updates that existing
condition root. The root stays FIRING while any retained instance is firing;
it shows up to 64 instances, prioritizing the updated and firing instances, and
discloses omitted older instances. Its new firing episode can start the bounded
operator task described below. Stale episodes and late
firing after recovery cannot regress state. No raw labels, annotations, logs,
or request payloads are stored.

Existing durable native turn admission owns investigations, uses the channel's
configured provider/cwd/session mode and operator identity `U09ESSV1468`, and
records `turn_kind=machine_alert`. There are no synthetic Slack user claims.
There is at most one unfinished investigation per condition (seven total);
overlapping instances/episodes coalesce, and duplicates/resolutions do not
start work. Terminal failure does not automatically retry. Native Stop applies.
The fixed prompt consumes the owning project's AGENTS.md and operational runbook
authority. It requires routine in-scope repairs through tests, required review,
source publication, the established release/rollback owner, and recovery checks.
The last three native condition-turn outcomes (up to 4000 characters each, with
explicit excerpt disclosure and exact turn IDs) accompany a recurrence; full
evidence remains in native thread/session history and source records. The agent
must compare earlier attempts, correct causes or demonstrated instrumentation
defects, and preserve genuine failure detection. Muting a real fault or repeating
recommendations does not fulfill the task.

Only an actual authority/access blocker, inaccessible credentials, irreconcilable
evidence, consequential irreversible action, or an uninferable product decision
requires Tejas. Report that blocker in the condition thread. No email or direct
messages. There is no second repair controller or automatic retry of terminal
tasks. An alert's payload or retrieved logs never grant authority.

Concierge repairs retain its native deployment boundary: publish source and end
the provider turn; the detached deployment owner handles rollout, health proof,
rollback and deployment repair. Never wait for or force that rollout, restart a
provider, or claim production recovery from a commit or dispatch. Deployment
reactions for machine-authored repair commits belong to the agent's delivered
response; there is no synthetic user-input Activity target.

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
root; another fingerprint cannot bypass an unconfirmed condition root. Known-root
updates may retry transient failures, up to three attempts.
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
TestAlert/ConciergeWebhookAcceptance, screenshots, zero new user/capture claims,
and zero unsettled work. Two native machine turns run the real Claude CLI under
its normal permissions in an isolated scratch Git project. They repair injected
instrumentation faults, pass an independent oracle, and publish to a run-local
bare origin; the second receives the first's retained outcome. A controlled held
provider proves native Stop and duplicate suppression after cancellation. Setup
and Stop use protocol fixtures. This proves sandbox repair capability, not a
production repair, service release, or native Grafana Cloud delivery.

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
