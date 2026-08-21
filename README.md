# Slack Concierge

A Slack-native front door for coding agents. Turn any channel into a durable,
resumable workspace for Codex and Claude Code, with per-project working
directories, threaded sessions, mid-turn steering, agent A/B comparison, and
capture-to-vault for notes and todos.

Concierge is the personal orchestration bot the author runs on a single
always-on box. It is published as a reference implementation, not a product —
see [Status](#status) before trying to adopt it wholesale.

## What it is

Concierge is a single Bolt + Socket-Mode bot that binds Slack channels to
filesystem projects and Slack threads to agent sessions. Every top-level
message in a managed channel starts an agent turn in that project's working
directory; every threaded reply resumes the same provider session. Two
providers are supported side by side — Codex (over its persistent JSON-RPC
`app-server`) and Claude Code (over `--print` streaming JSON) — and the
provider is bound to a thread on its first message so nobody can hijack a
thread mid-conversation by mentioning a different bot.

The bot is designed to run continuously across restarts and deploys. All
routing decisions, turn lifecycles, delivery attempts, capture writes, and
steering messages are persisted in SQLite before they take effect, so a crash
or a mid-turn deploy cannot silently double-post, double-capture, or leak
context between unrelated sessions.

## How it works

```
Slack  ──Socket Mode──▶  Concierge (Bun + Bolt)  ──▶  SQLite state.db
                              │
              ┌───────────────┼──────────────────┐
              ▼               ▼                  ▼
        Codex app-server   Claude Code CLI     whisper.cpp
        (JSON-RPC, one     (subprocess         (local audio
         persistent WS)     per turn)           transcription)
              │               │
              └───────┬───────┘
                      ▼
             ~/workspace/<project>/  ── vault symlinks ──▶  Obsidian vault
```

- **Slack transport.** Bolt over Socket Mode; no public URL required. All
  scope changes go through `slack-app-manifest.json`, never the App Config
  UI — the manifest is the source of truth and drift is easy to lose.
- **Channel ↔ project binding.** Each channel row in SQLite carries
  `code_path`, `vault_path`, and any additional writable directories. Regular
  messages dispatch an agent turn with `cwd=code_path` (or `vault_path` for
  vault-only channels). Slash commands and message shortcuts add captures,
  todos, forks, and channel-mode changes on top.
- **Providers.** A three-method `AgentProvider` interface (`run`, `fork`,
  transport-specific liveness) is implemented once for Codex and once for
  Claude Code. A short alias table (`bot/src/aliases.ts`) is the only place
  that maps `@cc`, `@cc-fast`, `@cx-medium`, etc. to a concrete
  provider+model.
- **Turn lifecycle.** Every user message atomically claims a channel-wide
  input row before any side effect, then is permanently classified as a turn,
  steering reply, inline capture, ignored, or drain-rejected input. Once a
  turn is running, replies in the same visible thread are routed as steering
  (Codex `turn/steer`, Claude Code `control_request`/`interrupt` + replayed
  user message) rather than being swallowed by capture or drain.
- **Durable Slack projection.** Each visible Slack thread owns one status
  message with a persisted `pending → sending → delivered → parked` lifecycle
  and a deterministic `client_msg_id`. Every turn refreshes a cumulative
  `TL;DR:` on that message; long agent replies are chunked into multiple
  Slack messages under the same thread.
- **Drain-aware deploys.** `bot/scripts/deploy.sh` asks the runtime whether
  any provider turn has a live owner before pulling or restarting. Long-
  running healthy agents are never killed to ship a deploy; only stale-owned
  rows are bypassed, and startup recovery reconciles them.
- **Capture surfaces.** `/todo`, `/note`, inline `todo:`/`note:` prefixes,
  and the "Send to inbox" / "Turn into todo" message shortcuts write to the
  project's `notes/inbox.md` in an Obsidian vault, and — when the channel has
  a Slack List — to that List as well, guarded by HMAC-authenticated source
  markers so a public permalink cannot cross-write into a different List.
- **Audio.** Slack audio clips are transcribed with a pinned `whisper.cpp`
  build (installer under `bot/scripts/install-transcriber.sh`) and fed into
  the turn as text. Transcription failure is a visible turn error, never a
  silent drop.

## Features

- Codex and Claude Code, side by side, with thread-bound provider selection.
- Text alias table for model selection (`@cc-fast`, `@cx-medium`, …).
- "Compare with another agent" message shortcut for one-shot A/B on the same
  prompt history in a fresh session.
- `/fork` and "Fork from here" for branching a thread from a specific message.
- Mid-turn steering: reply in a live thread and the reply reaches the
  provider mid-turn, in order, with durable acknowledgement.
- Slack Canvas per channel, one-way synced from `AGENTS.md`.
- Slack Lists per channel for todos, with the markdown file as the primary
  home and the List as a mirror.
- Slack permalink hydration: paste a thread link into a turn and Concierge
  resolves it via `conversations.replies` before invoking the provider.
- Slash commands: `/create-channel`, `/fork`, `/add-dir`, `/remove-dir`,
  `/todo`, `/note`, `/switch-provider`, `/mode`, `/auth-refresh`,
  `/review-inbox`, `/concierge-status`.
- Message shortcuts: Fork from here, Compare with another agent, Send to
  inbox, Turn into todo.

## Requirements

- Slack workspace where you can install a custom app (Socket Mode enabled).
- A machine that stays online. Concierge assumes a single service peer; the
  author runs it on a Hetzner AX41 under systemd.
- [Bun](https://bun.sh) for the bot runtime.
- [Codex CLI](https://github.com/openai/codex) with `codex app-server` for
  the Codex provider; [Claude Code](https://docs.claude.com/en/docs/claude-code)
  for the Claude Code provider. Both authenticate via their respective
  subscription OAuth (no API keys used).
- Optional: `ffmpeg` and build tools for `whisper.cpp` (audio-clip
  transcription); Obsidian vault + Obsidian Sync (three-way vault sync).

## Setup

1. **Clone and install:**
   ```bash
   git clone https://github.com/tejasdc/slack-concierge.git
   cd slack-concierge/bot
   bun install
   ```

2. **Create the Slack app from the manifest.** Go to
   <https://api.slack.com/apps>, choose "From an app manifest", paste
   `slack-app-manifest.json`, install it to your workspace, and grab the bot
   and app tokens from the OAuth & Permissions page.

3. **Write the config.** Concierge reads
   `~/.config/concierge/slack.toml` (mode 0600):
   ```toml
   bot_token       = "xoxb-…"
   app_token       = "xapp-…"   # Socket Mode
   signing_secret  = "…"
   # Optional — bot user IDs for skill routing
   claude_code_bot_user_id     = "U…"
   substack_editor_bot_user_id = "U…"
   ```

4. **Pick a state directory.** Default is `~/.local/state/concierge/`. It
   holds `state.db` (SQLite) and provider bookkeeping. Override with
   `CONCIERGE_STATE_DIR`.

5. **Run it:**
   ```bash
   cd bot
   bun run start
   ```
   Or install the systemd unit from `systemd/concierge-bot.service` and
   deploy via `bot/scripts/deploy.sh`, which is drain-aware and refuses to
   restart while a turn has a live owner.

## Repository layout

```
bot/
  src/         TypeScript source (Bolt handlers, providers, state, workers)
  scripts/     Deploy, healthcheck, drain-status, transcriber installer
  tests/       Bun test suite (state, routing, providers, delivery, …)
systemd/       Unit files for the bot and stub capture pipelines
docs/          Incident notes
AGENTS.md      Long-form agent-facing documentation (design invariants,
               deploy discipline, adopted-channel conventions, backups)
DESIGN.md      Original design doc from initial build
slack-app-manifest.json   Slack app definition — the source of truth for scopes
```

Secrets, `state.db`, and everything under `tmp/` are gitignored. The tests
use an in-memory state directory and never touch production.

## Deploying

- `bot/scripts/deploy.sh` pulls, refreshes the systemd unit, waits for a
  clean drain, and restarts. It fails closed on indeterminate liveness.
- The first rollout onto a version that added the admission gate uses
  `bot/scripts/bootstrap-deploy.sh` (documented in `AGENTS.md`); every
  subsequent deploy uses the atomic database gate.
- Machine-level backups (nightly `restic` of the state DB, config, and
  workspace) live in a separate repo and are not part of this codebase.

## Status

This is a personal, single-tenant project. It runs against one Slack
workspace, on one server, under a single user identity. The design bakes in
opinions — a fixed workspace root layout, an Obsidian vault as the note
substrate, subscription-authenticated provider CLIs, one persistent Codex
`app-server`, `bun` as the runtime — that are correct for the author's setup
but are unlikely to be a drop-in fit for anyone else.

There is no versioned release cadence, no compatibility guarantee across
commits, and no support commitment. Concierge is published so its design
decisions and their reasoning are readable — see `AGENTS.md` for the
invariants — and so specific pieces (steering protocol, drain-aware deploy,
durable Slack projection, capture claim state machine) can be borrowed
without inheriting the whole shape.

Contributions and issues are welcome but may go unanswered.

## License

MIT. See `LICENSE` if present; otherwise assume the standard MIT terms.
