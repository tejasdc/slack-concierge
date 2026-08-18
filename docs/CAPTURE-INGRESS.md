# Capture ingress

Concierge exposes one authenticated HTTPS boundary for external capture tools. Routes are data in `config/capture-routes.toml`; the HTTP server, source adapters, and destinations contain no route paths, Slack channel IDs, or secret values.

## Pebble Index 01 setup

First create and install the separate Slack app from
`capture-slack-app-manifest.json`. Its user OAuth token has exactly one scope,
`chat:write`, so the network-facing ingress never receives Concierge's broad
user token. Store the resulting `xoxp-…` token without posting it to Slack:

```bash
sudo install -m 0600 /dev/stdin /etc/concierge/capture-slack.token
```

Deploy verifies both `auth.test` and the exact `X-OAuth-Scopes` response before
starting ingress. A missing or over-scoped credential stops the deployment.

Use these values in Pebble → Index → Settings → Advanced → Webhook:

| Setting | Value |
| --- | --- |
| Webhook URL | `https://95-217-119-40.sslip.io/pebble` |
| Header name | `Authorization` |
| Header value | `Bearer <contents of /etc/concierge/pebble-index.token>` |
| Send | `Transcription only` |
| Trigger | `Both` to route every recording; choose one gesture only if routing is meant to be selective |

Do not paste the bearer token into Slack or commit it. Read it directly on AX41 when configuring the phone:

```bash
sudo cat /etc/concierge/pebble-index.token
```

For minimum latency, use Pebble's `Cloud Only` speech recognition mode. Pebble documents it as the fastest and most accurate option. `Local Only` keeps speech-to-text on the phone and uses the same webhook, but takes longer. Server-side `whisper.cpp` remains the fallback for Slack audio clips; it is deliberately not placed in the Pebble hot path because the phone has already produced the transcript.

The public health check is:

```bash
curl https://95-217-119-40.sslip.io/health
```

## Request path

```text
Pebble phone app
  → Caddy HTTPS termination
  → agent-inbox.service on 127.0.0.1:8080
  → exact configured route + constant-time bearer check + body limit
  → source adapter validation
  → durable capture_events row in /var/lib/concierge-capture/state.db
  → configured Slack destination
  → #slack-inbox router agent
```

The server acknowledges a new Pebble event with HTTP `202` after SQLite persistence, before waiting for Slack. Retries produce the same event ID from the route, recording timestamp, client, and transcript. Slack delivery also uses a deterministic `client_msg_id`. Every `sending` row records the exact process PID, boot ID, and process start time; startup or deployment recovers it only after that identity is proven dead. Transient Slack failures retry with bounded exponential backoff, and permanent Slack contract/auth failures are parked for inspection. A non-retryable local state failure terminates ingress gracefully instead of leaving a live-owned lease stranded; systemd restarts it and recovery can then prove the old owner dead. Slack calls time out after 10 seconds, at most two deliveries run concurrently, and a rendered transcript above Slack's 40,000-character ceiling is rejected instead of being silently truncated.

Deploy first acquires `capture_delivery_gate` in the capture database, then acquires Concierge's turn gate. The gate claim and each delivery claim are mutually exclusive SQLite transactions, and a deploy cannot claim the gate while a live process owns a `sending` capture. Proven-dead delivery owners are recovered atomically. Before Concierge restarts, the capture gate changes to durable `held` mode; a failed restart or health probe cannot release it. Failure cleanup asks SQLite to release only a still-live gate, so a hold that committed despite an ambiguous child-process result remains closed. A later deploy can atomically adopt a dead deployment owner's hold. Ingress therefore keeps persisting new captures but pauses Slack delivery without a check/claim race. Queued captures resume only after both services pass health checks and the exact gate token is released. The stopped-service bootstrap enters held mode before ingress first starts.

The transcript is stored in the durable event row because that is the replay source until Slack confirms delivery. Tokens and transcript bodies are never included in service logs.

## Pebble contract

The `pebble-index` adapter accepts Pebble's HTTPS `multipart/form-data` request with:

- `transcription`: required non-empty text
- `recordedAt`: required Unix timestamp in milliseconds
- `client`: optional text, defaulting to `ring`
- `audio`: rejected on the transcript-only route so an accidental `Both` payload cannot bypass its 256 KiB memory bound

Authentication is a route-specific `Authorization: Bearer …` value held in a mode-600 file. The deployed process receives route auth, route config, and the dedicated `chat:write`-only capture-app token through systemd credentials. Missing/incorrect auth returns `401`; malformed fields return `4xx`; unexpected persistence failure returns `503` so the sender can retry.

## Configuring another flow

Add another `[[routes]]` entry to `config/capture-routes.toml`. A route owns:

- stable ID and exact URL path
- source adapter (`pebble-index` or `raw-body` today)
- independent request-size ceiling
- authentication header/scheme and systemd credential name
- destination type and destination configuration

The existing `/audio` route demonstrates the second adapter/destination pair: authenticated raw audio is streamed to a same-directory temporary file, hashed while arriving, and atomically linked into `/var/agent-inbox`. It preserves the Watch/iPhone Shortcut fallback—including its `201` response and `application/json`/`text/plain` compatibility—without buffering the 64 MiB ceiling twice in memory. Normal restarts stop accepting new requests and wait indefinitely for active uploads to receive `201`; the 15-second idle timeout still ends dead connections. On the one-time legacy migration, a named conntrack rule blocks new Caddy-to-ingress connections while established uploads finish, then deploy replaces the service and removes the rule.

Adding a new request shape requires implementing the `Capture` adapter contract. Adding a new sink requires implementing `CaptureServices`; route selection and security stay unchanged. Ordinary new instances of an existing adapter/destination require config only.

Deploy through `bot/scripts/deploy.sh`. It creates the dedicated `concierge-capture` identity, builds the root-owned runtime outside `/root`, installs the versioned `agent-inbox.service`, creates missing route secrets without overwriting them, verifies the separately provisioned capture-app credential and exact scope, restarts the ingress, and requires a successful local health probe before restarting the Slack bot.

## Operations

Useful checks:

```bash
systemctl status agent-inbox.service
journalctl -u agent-inbox.service --since "30 min ago"
sqlite3 /var/lib/concierge-capture/state.db \
  "select event_id, route_id, status, delivery_attempts, delivery_error from capture_events order by created_at desc limit 20;"
```

The public URL terminates TLS in Caddy and only the loopback listener reaches the Bun service. The systemd unit runs as `concierge-capture`, hides `/root`, makes the complete filesystem read-only, drops all capabilities, bounds memory/tasks, and grants writes only to its private state and legacy audio directories. The process cannot read the code checkout or the bot's general Slack configuration.
