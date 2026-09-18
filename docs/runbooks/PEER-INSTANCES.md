# Peer Concierge instances (the Mac)

A second Concierge runs on Tejas's Mac so work that needs his local checkout, files or
apps has an owner. Each instance keeps its own ledger, FIFO, request/return obligations
and recovery; nothing is shared. The design and its rationale are in Thinkering's
[plan](https://github.com/tejasdc/thinkering/blob/main/docs/plans/2026-09-18-concierge-portable-mac.md).

| Instance | Name | Runs | Owner API | Listener |
| --- | --- | --- | --- | --- |
| remote-box | `cloud` | `systemd/concierge-bot.service` (Slack, Inbox, capture, deployment) | `/root/.local/state/concierge/requests.sock` | `100.118.245.110:8788` |
| Mac | `mac` | `launchd/com.tejasdc.concierge.plist` as Tejas, Slack-free (`CONCIERGE_SLACK_ENABLED=0`) | `~/Library/Application Support/concierge/requests.sock` | `100.90.183.122:8788` |

Both listeners serve `/sessions/v1/*` only, bound to the instance's Tailscale address, and
require `Authorization: Bearer <token>` with the bytes of the shared token file. The
Unix socket keeps working without a token. Holding the token is equivalent to root
access to the socket; Tailscale limits who can reach the port.

## Install or update the Mac instance

```sh
cd ~/workspace/slack-concierge && git pull --ff-only && scripts/install-mac.sh
```

The script pins bun 1.3.14 under the state directory, installs locked dependencies,
copies `router-actions.sh` to `~/.local/bin`, renders the plist with this Mac's tailnet
address and provider executables, and (re)starts the agent. Logs:
`~/Library/Application Support/concierge/logs/concierge.{log,err}`. Check:

```sh
launchctl print gui/$(id -u)/com.tejasdc.concierge | grep -E 'state|pid'
curl -s --unix-socket "$HOME/Library/Application Support/concierge/requests.sock" http://localhost/sessions/v1/status
curl -s -H "Authorization: Bearer $(cat "$HOME/Library/Application Support/concierge/peer.token")" http://100.90.183.122:8788/sessions/v1/peers
```

Projects are every `~/workspace/<dir>` with `.git` and `AGENTS.md`. Codex uses the Mac's
own app-server daemon; if it is down the observer logs
`codex_session_observer_disconnected` and Claude sessions are unaffected. There is no
Inbox, capture ingress or deployment pipeline on the Mac; `GET /sessions/v1/inbox`
answers 503 there.

## Token rotation

1. `openssl rand -hex 32 > ~/Library/Application\ Support/concierge/peer.token` on the Mac.
2. Copy the same bytes to remote-box `/etc/concierge/peer.token` (mode 0600, root).
3. Restart both instances (`launchctl kickstart -k gui/$(id -u)/com.tejasdc.concierge`;
   `systemctl restart concierge-bot`) and Thinkering, which reads the same file.

Nothing caches the token across restarts. A mismatch shows as `PEER_UNAUTHORIZED` in
`sessions peers` and in Thinkering's owner status; the token is never logged.

## How agents reach the other instance

`router-actions.sh sessions peers` lists configured peers with live reachability.
`sessions projects --peer mac`, `sessions search --peer mac` and
`sessions ask --peer mac …` create or address a session on the peer; the request keeps
its return obligation on the asking instance and the answer arrives through the same
service-return path as a local reply. On the peer, the recipient replies with the
ordinary `sessions reply <request-id>`; the reply is forwarded to the origin and retried
until it lands. Details: `bot/src/session-peers.ts`, tables `session_peer_requests`,
`session_peer_events` (origin) and `session_peer_deliveries`, `session_peer_replies`
(target). The [router runbook](ROUTER-ACTIONS.md) has the CLI.

## When a peer is down

- Mac asleep or offline: `sessions ask --peer mac` fails at acceptance with
  `PEER_UNREACHABLE` and records nothing. Requests already delivered keep their rows on
  both sides; the target retries its notifications and replies every minute while
  something is owed, and the origin's 30-minute inspection reports `peer mac unreachable`.
- remote-box down: the Mac keeps running its own sessions; replies to cloud requests stay
  `pending` and forward when the box answers.
- Neither side ever replays a provider effect for the other.
