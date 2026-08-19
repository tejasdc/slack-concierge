# Capture ingress

Concierge exposes authenticated HTTPS capture routes whose paths, source
adapters, limits, credentials, labels, and destinations are data in
`config/capture-routes.toml`. The public service has no Slack or provider
credential. It durably accepts text captures; the trusted Concierge process
owns Slack delivery through a private loopback queue API.

## Pebble Index 01 setup

No additional Slack app or OAuth scope is required. Pebble uses a route-specific
bearer token, while Concierge reuses the `user_token` already configured for
trusted user-authored Slack posts.

Use these values in Pebble → Index → Settings → Advanced → Webhook:

| Setting | Value |
| --- | --- |
| Webhook URL | `https://capture.tejas.nyc/pebble` |
| Header name | `Authorization` |
| Header value | `Bearer <contents of /etc/concierge/pebble-index.token>` |
| Send | `Transcription only` |
| Trigger | `Both` for every recording, or one gesture for selective routing |

Do not paste either bearer token into Slack or commit it. Read the Pebble token
directly on AX41 when configuring the phone:

```bash
sudo cat /etc/concierge/pebble-index.token
```

For minimum latency, use Pebble's cloud transcription and send only its
transcript. Server-side `whisper.cpp` remains the fallback for Slack audio clips
and the historical Watch/iPhone `/audio` route; it is not in the Pebble path.

Public health:

```bash
curl https://capture.tejas.nyc/health
```

## Request and delivery path

```text
Pebble phone app
  → capture.tejas.nyc Cloudflare Worker (exact /pebble and /health allowlist)
  → Caddy HTTPS origin
  → agent-inbox.service public listener on 127.0.0.1:8080
  → exact configured route + constant-time bearer check + body limit
  → source adapter validation
  → durable capture_events row in /var/lib/concierge-capture/state.db
  → HTTP 202

Concierge bot
  → authenticated queue listener on 127.0.0.1:8081
  → owner-bound claim-next
  → Slack chat.postMessage with existing user_token
  → configured #slack-inbox destination
  → ordinary user-message Socket Mode routing
  → owner-bound delivered/retry/park acknowledgement
```

The public listener and private queue listener are separate Bun servers. Caddy
reaches only port 8080. Both queue clients must present the root-generated
`capture_queue` systemd credential; the queue server rejects non-loopback bind
configuration. `concierge-capture` is the only routine SQLite owner, avoiding
cross-UID database/WAL ownership races.

The server acknowledges a new Pebble event only after SQLite persistence.
Retries produce the same event ID from the route, recording timestamp, client,
and transcript. Slack delivery uses a deterministic `client_msg_id`.

Concierge generates one stable claim ID before asking for work. A claim records
that ID plus Concierge's PID, boot ID, and process start ticks. Repeating the
same claim after a lost HTTP response returns the same event without increasing
its attempt count. Delivered, retry, and park acknowledgements are conditional
on the exact claim and owner and return their already-committed result when a
response was lost. A later worker recovers `sending` work only after proving the
prior process identity dead. An unrecoverable live-owner failure terminates the
bot so recovery never steals work from a still-running owner.

Transient Slack failures retry with bounded exponential backoff. Permanent
Slack contract/auth failures park the event for inspection. Slack calls time
out after ten seconds, and a rendered transcript above Slack's 40,000-character
ceiling is rejected before persistence.

Deploy first claims `capture_delivery_gate`, then Concierge's turn gate. New
webhooks continue to persist while delivery is held. Ingress starts and passes
its local probe before Concierge restarts. Concierge validates the private queue
credential and its existing Slack user token, connects Socket Mode, and starts
the capture worker before emitting the current-invocation
`concierge_bot_online` readiness marker. Only then may deploy release both exact
gate tokens. A failed restart or readiness probe leaves capture delivery held.

Tokens and transcript bodies are never included in service logs.

## Pebble contract

The `pebble-index` adapter accepts Pebble's HTTPS `multipart/form-data` request:

- `transcription`: required non-empty text
- `recordedAt`: required Unix timestamp in milliseconds
- `client`: optional text, defaulting to `ring`
- `audio`: rejected on the transcript-only route

The route has a 256 KiB maximum body. Missing or incorrect auth returns `401`,
malformed fields return `4xx`, and persistence failure returns `503` so Pebble
can retry.

## Configuring another flow

Add another `[[routes]]` entry to `config/capture-routes.toml`. A route owns its
stable ID, URL path, source adapter, body ceiling, auth credential, label, and
destination. Existing adapter/destination combinations require configuration
only; a genuinely new request shape implements the capture adapter contract.

The historical `/audio` route remains an authenticated `raw-body` → directory
flow. It streams into a same-directory temporary file and atomically links it
into `/var/agent-inbox`, preserving the Watch/iPhone Shortcut contract, `201`
response, compatible content types, 64 MiB limit, idempotent hash-derived name,
and graceful completion of active uploads during restart.

## Readable edge hostname

`cloudflare/capture-worker/` owns the `capture.tejas.nyc` Worker custom domain.
The Worker proxies only exact `POST /pebble` and `GET /health` requests to the
existing `sslip.io` Caddy origin. It rejects unknown paths, trailing paths,
queries, and wrong methods before contacting the origin. It does not log,
persist, authenticate, retry, or transform request bodies; ingress remains the
security and validation authority.

Deploy the edge from the repository root using the sanctioned shared Cloudflare
credential:

```bash
wrangler deploy --config cloudflare/capture-worker/wrangler.toml
```

## Operations

```bash
systemctl status agent-inbox.service concierge-bot.service
journalctl -u agent-inbox.service -u concierge-bot.service --since "30 min ago"
sqlite3 /var/lib/concierge-capture/state.db \
  "select event_id, route_id, status, delivery_attempts, delivery_error from capture_events order by created_at desc limit 20;"
```

`agent-inbox.service` runs as `concierge-capture`, hides `/root`, makes the
filesystem read-only, drops capabilities, bounds memory/tasks, and writes only
its private state and legacy audio directories. It receives route secrets, the
queue secret, and route config—but no Slack/provider credential. The Concierge
service receives the queue secret through its own systemd credential directory.
Capture ingress validates systemd's delivered credential shape exactly: the
private directory must be `0500` or ACL-presented `0550`, and credential files
must be `0400` or ACL-presented `0440`. systemd v255 adds the group bits when it
grants a non-root service access inside the root-owned, unit-private directory;
writes, execute bits, symlinks, and all other-user access remain rejected.

Deploy only through `bot/scripts/deploy.sh`. It creates both route secrets and
the internal queue secret without overwriting existing values, installs the
root-owned capture runtime/config, replaces the historical service safely, and
requires both ingress and Concierge readiness before releasing delivery.

## Change discipline

Capture changes must preserve `/audio` compatibility, route-security coverage,
durable-before-`202` acceptance, idempotent claim/ack behavior, the absence of a
Slack credential from ingress, and this document in the same commit. Paths,
limits, route credentials, labels, and destinations belong in TOML rather than
flow-specific server branches.
