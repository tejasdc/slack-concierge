# Slack Concierge — Status snapshot

**Timestamp:** 2026-08-05 22:29 PT (05:29 UTC 2026-08-06)

## Where we are

### ✅ Confirmed working end-to-end (via real Slack API round-trip as Tejas)

| R-* | Feature | Evidence |
|---|---|---|
| R-CHAN-2 | Top-level message → new session | Post "what is 4×5?" → Concierge replies "20" in 7s |
| R-CHAN-3 | Thread reply → session RESUME with prior UUID | Reply "multiply by 2" → Concierge replies "40" (remembered 20) |
| R-CHAN-4 | No @-mention needed | Reply landed without mentioning `@concierge` |
| R-PROV-2 | Codex is default provider | Turn footer shows `provider: codex` |
| R-TURN-1 | No streaming — single final reply | Bot posts "working…" then edits with final |
| R-DB-3 | Session UUID persisted to state.db (bun:sqlite) | `SELECT agent_session_uuid FROM sessions` returns UUID |
| R-INFRA-1 | AX41 dedicated server | 95.217.119.40, Ryzen 5 3600, 64GB RAM |
| R-INFRA-8 | Tokens at `/root/.config/concierge/slack.toml` chmod 600 | ✓ |
| R-HEALTH-1 | Bot under systemd Restart=always | `concierge-bot.service` active |
| R-NAME-1/2 | Bot name Concierge, repo `slack-concierge` | ✓ |

### 🔧 Fixes deployed this session

1. **Codex JSONL parser was completely wrong** — I had guessed at the event shape. Real shape is `thread.started {thread_id}`, `turn.started`, `item.completed {item:{type,text}}`, `turn.completed`. Parser now correctly extracts session UUID and joins all `agent_message` items into the final reply.

2. **Slack Bolt `ignoreSelf: true` was blocking API-driven testing.** Messages posted via user token from the installed app carry a `bot_id` matching the app, so Bolt was silently filtering them. Set `ignoreSelf: false` + filter only on our own bot's user_id/bot_id.

3. **The `/new` welcome text used to say "Mention @concierge…"** — already replaced upstream with "Every message here starts or continues an agent turn." Existing `#hello-world` still shows the old text (posted before the code change); new channels will get the correct text.

### 🚧 Dispatched to Codex (in-flight, expected 30-60 min)

A single comprehensive Codex agent is implementing the remaining 70+ requirements. Files so far touched (as of 22:29 PT):
- `bot/src/artifacts.ts` (new — artifact upload)
- `bot/src/log.ts` (new — structured logging)
- `bot/src/rate-limit.ts` (new — Slack 429 handling + msg/min bucket)
- `bot/src/text.ts` (new — probably long-msg splitting)
- `bot/src/state.ts` (updated — schema migrations)
- `bot/package.json` (updated deps)

Codex said mid-run: *"The DB/state layer is now additive and idempotent. Next I'm replacing the current project scaffolding and Codex subprocess code so /new, /promote, additional dirs, and provider calls all share the same path rules."*

The prompt covers: multi-hierarchy paths, `/promote`, `/fork` (Codex has `codex exec fork` subcommand), `/add-dir`, `/remove-dir`, `/todo`, `/note`, `/auth-refresh`, `/mode`, `/switch-provider`, message shortcuts (Fork from here, Send to inbox, Turn into todo), AgentProvider abstraction with Claude Code stub, multi-bot skills routing, channel modes with `!note`/`!todo` inline prefixes, Canvas/Lists integration, artifact upload from `.artifacts/`, long-message chunking, 429 handling, structured logging, Socket-Mode watchdog, `#bot-status` heartbeat, OAuth expiry warning, Monologue poller unit, journalmaxx port skeleton, migrations for `turns`/`parent_session_id`/`additional_paths`/`bot_user_id` columns.

### ❗ What Tejas will need to do when Codex finishes

1. **Slack app scope reinstall.** Codex will write an updated `slack-app-manifest.json` and impl-summary.md will list the new scopes (likely: `channels:manage`, `channels:read`, `groups:read`, `files:write`, `slack_lists:read`, `slack_lists:write`, `commands`, `chat:write.public`). Tejas needs to open the Slack app admin UI → Settings → Manifest → paste → **Reinstall to workspace** to grant the new scopes.

2. **Approve any new slash commands** the manifest declares. Slack will prompt on install.

3. **Verify the bot user_token has `channels:read,groups:read,mpim:read,im:read`.** Currently missing — blocks `conversations.list` from the user token. Bot token can substitute for most calls.

### 🧪 E2E test suite ready

`e2e-suite.sh` at `~/.claude/jobs/1a9cbe29/tmp/` runs 40+ tests covering every R-* item on the checklist. Will run after Codex finishes.

### 📋 Open items Codex may not close

- **`obsidian-sync ENAMETOOLONG` on `Readwise/…Abjk…md`** — needs one-off filename fix on Mac side.
- **journalmaxx content not yet on AX41** — Obsidian Sync still downloading older Readwise archive. Journal content will land as sync progresses.
- **chess-with-friends migration** from Mac — pending.
- **Pebble webhook** — physical device arrives ~1 week; endpoint stub only.

### Wakeup schedule

Auto-checking every 30 min. Codex notification will interrupt when done.

## Autonomous mode — Tejas is offline

Tejas signed out at ~22:35 PT 2026-08-05. Full autonomy: implement + test + verify every requirement without further check-ins. Do NOT stop the loop until (a) e2e-suite passes on both providers, (b) chess-app demo runs end-to-end producing real artifacts, (c) Codex reviewer says all requirements are closed. If truly blocked (e.g. needs Slack scope reinstall), document it in STATUS.md and continue on everything else in parallel.

### Chess app is the reference demo

Not toy math. Real workflow: `/new chess` → build a browser chess game with friend-multiplayer + Stockfish AI. Iterate through many turns in the main thread, fork mid-way for design variants, add requirements as you go (mirroring how Tejas actually works). Prove: multi-turn sessions, forks, artifacts (board image), long code chunking, heartbeat visibility, parallel Claude Code thread on same channel.
