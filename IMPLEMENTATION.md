# Slack Concierge — Implementation Plan

**Owner:** Tejas DC · **Depends on:** DESIGN.md · **Status:** ready to build after Codex review

Phases numbered by dependency order. Phase N assumes Phase N-1 complete.

## Phase 0 — foundation (done or in flight)

- [x] AX41 cleaned, RAID/zram/swap healthy
- [x] Caddy + HTTPS `/audio` inbox endpoint at `https://95-217-119-40.sslip.io/` (backup capture path, proven with 36-min Watch upload)
- [x] Node 22, npm globals: `claude`, `codex`, `ob`, `bun`, `monologue`
- [x] zsh + oh-my-zsh + powerlevel10k + plugins + Tejas's `.zshrc` aliases
- [x] Claude Code OAuth logged in
- [x] Codex OAuth logged in
- [x] Monologue CLI onboarded, tested end-to-end (18-min Watch note round-trip)
- [x] Obsidian Sync paired to remote vault (journalmaxx catch-up pending on Mac side)

## Phase 1 — obsidian-sync as systemd service

- [ ] `/etc/systemd/system/obsidian-sync.service`
  - `ExecStart=/usr/bin/ob sync --continuous /root/workspace/vault`
  - `Restart=always` `RestartSec=5`
  - Logs to journal
- [ ] `systemctl enable --now obsidian-sync`
- [ ] Verify: `journalctl -u obsidian-sync -f` shows heartbeat every N seconds; edit on Mac → appears on AX41 within seconds; reverse also works

## Phase 2 — the `concierge` CLI (standalone, callable from anywhere)

TypeScript. Lives at `~/workspace/slack-concierge/cli/`. Compiled to `~/.local/bin/concierge`.

Commands:
- [ ] `concierge new <name>` — vault-only channel. Creates `~/workspace/vault/<group>/<name>/{AGENTS.md, notes/inbox.md}`
- [ ] `concierge new-code <name>` — coding channel. Also creates `~/workspace/<group>/<name>/` with `git init`, symlinks
- [ ] `concierge promote <name>` — convert vault-only to coding (idempotent)
- [ ] `concierge fork <session-id> [--from-message-idx N]` — fork a session. Dispatches to `codex fork` or `claude --fork-session` per provider
- [ ] `concierge add-dir <channel> <path>` — update `channels.additional_paths` in state.db
- [ ] `concierge remove-dir <channel> <path>`
- [ ] `concierge list` — list all channels + statuses
- [ ] `concierge status` — health check (sync running, oauth valid, etc.)

Parses channel name via first-underscore split: `blogs_binding-values` → group=`blogs`, name=`binding-values`.

Idempotent: safe to re-run. Writes state to `~/.local/state/concierge/state.db` (SQLite via `better-sqlite3`).

## Phase 3 — Monologue poller

Bash + Python.

- [ ] `/opt/monologue-poll/poll.py`
  - Reads cursor from `~/.local/state/monologue-cursor` (ISO 8601 timestamp)
  - Calls `monologue notes all --updated-after <cursor>`
  - For each new note: writes `~/workspace/vault/inbox/monologue-<uuid>.md` with YAML frontmatter (id, recorded_at, title) + body (transcript)
  - Updates cursor to now
- [ ] `/etc/systemd/system/monologue-poll.service` (oneshot)
- [ ] `/etc/systemd/system/monologue-poll.timer` (every 3 min)
- [ ] `systemctl enable --now monologue-poll.timer`

## Phase 4 — port journalmaxx to AX41

Take the Mac pipeline verbatim, retarget file paths, replace LaunchAgents with systemd units.

- [ ] Copy `~/workspace/obsidian-vault/voice-memo-transcription/voicememo/` + `~/workspace/obsidian-vault/journalmaxx-auto-capture/` to AX41
- [ ] `apt install inotify-tools` (fswatch equivalent)
- [ ] `/etc/systemd/system/journalmaxx-ingest.service` — inotifywait on `~/workspace/vault/inbox/`, invokes `claude -p -c "/ingest"` on each new file
- [ ] `/etc/systemd/system/journalmaxx-patterns.timer` — daily
- [ ] Extend `/ingest` prompt: add category `project-note-for-<channel>` alongside existing journal/todo/idea/atom. When emitted, ingest also appends atom to `~/workspace/vault/<channel-path>/notes/inbox.md`
- [ ] Verify: dictate a Monologue note → transcript lands in `vault/inbox/` → ingest fires → daily note updated + (if project-referenced) per-project inbox updated

## Phase 5 — Slack app creation (Concierge)

Via Chrome extension against `api.slack.com/apps`.

- [ ] Create app "Concierge" from manifest JSON:
  - Bot user
  - Socket Mode enabled
  - Scopes: `channels:read`, `channels:manage`, `chat:write`, `chat:write.public`, `channels:history`, `im:read`, `im:write`, `im:history`, `groups:history`, `groups:read`, `app_mentions:read`, `commands`, `files:read`, `files:write`, `reactions:read`, `users:read`, `slack_lists:read`, `slack_lists:write`
  - Event subscriptions: `message.channels`, `message.im`, `message.groups`, `channel_created`, `app_mention`, `file_shared`
  - Slash commands: `/new`, `/new-code`, `/promote`, `/fork`, `/add-dir`, `/remove-dir`, `/auth-refresh`, `/ping`, `/todo`, `/note`
  - Message shortcuts: "Fork from here", "Send to inbox", "Turn into todo"
- [ ] Install to `tejazz.slack.com` workspace
- [ ] Extract bot token (xoxb-), app token (xapp-), signing secret
- [ ] Write to `/root/.config/concierge/slack-concierge.toml` on AX41 (0600)

## Phase 6 — Concierge bot (forked from Noos, adapted)

TypeScript. Lives at `~/workspace/slack-concierge/bot/`.

- [ ] Fork `~/workspace/ideaflow/noos/` into `~/workspace/slack-concierge/bot/`
- [ ] Strip Neo4j: delete `src/lib/neo4j*.ts`, `src/api/nodes*.ts`, `src/api/relationships*.ts`
- [ ] **Fix in-memory session Map bug:** `src/slack/claude/sessions.ts:16` — replace `Map<string, string>` with SQLite-backed lookup. Persist every `storeResumeSessionId()` call to `sessions.agent_session_uuid`
- [ ] Wire SQLite state (`~/.local/state/concierge/state.db`) via `better-sqlite3`
- [ ] Copy verbatim: `src/slack/backfill/rate-limit.ts`, `src/slack/claude/runner.ts:40-151` (abort registry)
- [ ] Replace Neo4j-specific tool wiring in `runner.ts:executeNoosToolCall` with concierge's tools (channel-management, file access, git ops)
- [ ] Add Codex `app-server` client: persistent WebSocket via `ws://localhost:6543` (locally spawned `codex app-server` daemon)
- [ ] Implement AgentProvider interface with both Codex and Claude Code backends
- [ ] Wire slash commands to `concierge` CLI subprocesses
- [ ] Wire message shortcuts to appropriate handlers
- [ ] `/etc/systemd/system/concierge.service` — runs bot process, Restart=always

## Phase 7 — codex app-server as systemd service

- [ ] `/etc/systemd/system/codex-app-server.service`
  - `ExecStart=/usr/bin/codex app-server daemon start --listen ws://127.0.0.1:6543 --ws-auth signed-bearer-token`
  - Restart=always
- [ ] Configure signed-bearer-token, share secret with concierge bot config
- [ ] Verify: concierge can send `thread/start` and get back a `threadId`

## Phase 8 — end-to-end smoke test

- [ ] In tejazz.slack.com, type `/new hello-world`
  - Bot creates `~/workspace/vault/hello-world/{AGENTS.md, notes/inbox.md}`
  - Bot posts confirmation with path
- [ ] Send message in `#hello-world`: "list the files in this project"
  - Bot picks default provider (codex), sends `turn/start`, edits reply with heartbeat, replaces with final text
  - Session UUID persisted in `state.db`
- [ ] Reply in the same thread: "count them"
  - Bot resumes same session via `thread/resume`
  - Same session UUID used
- [ ] Type `/promote` in `#hello-world`
  - Bot creates `~/workspace/hello-world/` with `git init`, symlinks AGENTS.md/CLAUDE.md/notes back to vault
- [ ] Use "Fork from here" message shortcut on the 2nd message
  - Bot creates new thread, uses `thread/fork` with `atMessageIdx=1`, replies with new thread pointer
- [ ] Dictate a Monologue note mentioning "hello-world"
  - 5 min later, transcript in `vault/inbox/`, ingest fires, atom appended to `vault/hello-world/notes/inbox.md`
- [ ] Verify visible on iPhone Obsidian mobile

## Phase 9 — optional next steps (post-MVP, when signal warrants)

- Additional skill bots (`@substack-editor`, `@brief-summarizer`) with their own Slack app installs
- Router agent in `#inbox` for auto-routing captures to project channels
- Slack Lists per project for structured todo tracking
- Image/artifact upload flow when agent produces files
- Pebble Ring webhook integration when Tejas receives the ring
- Auto-metrics / dashboard (Grafana on AX41 reading state.db)

## Estimated build time

| Phase | Time |
|---|---|
| 1. obsidian-sync systemd | 15 min |
| 2. concierge CLI | 4 hours |
| 3. Monologue poller | 1 hour |
| 4. journalmaxx port | 4-6 hours |
| 5. Slack app creation | 1 hour |
| 6. Concierge bot (fork Noos + adapt) | 8-12 hours |
| 7. codex app-server systemd | 30 min |
| 8. E2E smoke test | 2 hours |
| **Total to end of Phase 8** | **20-27 hours** |

Realistic across a few sessions.
