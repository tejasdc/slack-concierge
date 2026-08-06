# Slack Concierge — Design

**Date:** 2026-08-05 (v2, consolidating all decisions)
**Owner:** Tejas DC
**Related:** REQUIREMENTS.md (running log), IMPLEMENTATION.md (build plan)

---

## 0. What we're building

A Slack workspace that orchestrates a personal always-on agent stack running on Tejas's Hetzner AX41 dev box. **Concierge** is the overall coordinator bot (main entry point + router). Skill bots (`@codex`, `@claude-code`, `@substack-editor`, …) are separate Slack app installs handled by the same backend. journalmaxx personal-knowledge pipeline is ported to AX41 and shares the same trunk. Everything durable lives in one Obsidian vault synced across AX41 + Mac + iPhone.

## 1. Devices + data flow

```
┌──────────────────┐          ┌───────────────────┐          ┌────────────────┐
│  Apple Watch     │─(voice)─▶│   Monologue       │─(poll)──▶│                │
│  iPhone          │          │   cloud (Every)   │          │                │
│  Mac Monologue   │          └───────────────────┘          │                │
│  Pebble Ring     │─(webhook)───────────────────────────────▶│    AX41        │
│  (when arrives)  │                                          │  (Ubuntu       │
│                  │                                          │   24.04, 12t,  │
│  Watch Shortcut  │─(HTTPS POST direct)─────────────────────▶│   64GB RAM,    │
│  (backup path)   │                                          │   RAID1)       │
└──────────────────┘                                          │                │
                                                              │                │
┌──────────────────┐                                          │  ~/workspace/  │
│  Slack           │◀─(Bolt + Socket Mode WebSocket)────────▶ │   vault/       │
│  (tejazz         │                                          │   <projects>/  │
│    .slack.com)   │                                          │                │
└──────────────────┘                                          └────────────────┘
       ▲                                                              │
       │                                                              │ obsidian-headless
       │ Obsidian Sync                                                │ (systemd, continuous)
       │ (same subscription,                                          ▼
       │  same vault)                                       ┌─────────────────┐
       │                                                    │ Obsidian Sync   │
       └────────────────────────────────────────────────────│ cloud (Obsidian)│
                                                            └─────────────────┘
              ▲                                                       │
              │                                                       │
        ┌─────────────┐                                     ┌─────────────┐
        │  Mac        │◀───────────────────────────────────▶│  iPhone     │
        │  Obsidian   │                                     │  Obsidian   │
        └─────────────┘                                     └─────────────┘
```

## 2. Trunk — one vault, one workspace root, symlinks for coding projects

```
~/workspace/                                            # on AX41 (matches Mac layout)
├── vault/                                              # Obsidian vault (synced 3-way)
│   ├── .obsidian/                                      # Obsidian config
│   ├── inbox.md                                        # global inbox
│   ├── journal/                                        # journalmaxx daily notes
│   │   ├── daily/YYYY/MMM/DD.md
│   │   └── singletons/
│   ├── ideaflow/cortex/                                # notes for coding-project cortex
│   │   ├── AGENTS.md                                   # real file (agent instructions)
│   │   └── notes/
│   │       └── inbox.md                                # per-project inbox
│   ├── blogs/binding-values/                           # pure-writing project (lives in vault)
│   │   ├── AGENTS.md
│   │   └── notes/inbox.md
│   └── slack-concierge/                                # this project's notes
│       ├── AGENTS.md
│       └── notes/{inbox.md, DESIGN.md, REQUIREMENTS.md}
│
├── ideaflow/cortex/                                    # CODE (git repo, node_modules)
│   ├── AGENTS.md    -> ../../vault/ideaflow/cortex/AGENTS.md
│   ├── CLAUDE.md    -> AGENTS.md                       # both agents read same file
│   ├── notes/       -> ../../vault/ideaflow/cortex/notes/
│   ├── .claude/                                        # code-side agent config (NOT in vault)
│   └── src/, package.json, .git/
│
└── slack-concierge/                                    # the concierge codebase (this project)
    ├── AGENTS.md    -> ../vault/slack-concierge/AGENTS.md
    ├── CLAUDE.md    -> AGENTS.md
    ├── notes/       -> ../vault/slack-concierge/notes/
    └── src/, ...

~/.agents/skills/<name>/ -> ~/workspace/skills/<name>/  # skill deployment
~/.claude/skills/<name>  -> ~/workspace/skills/<name>/
~/.codex/skills/<name>   -> ~/workspace/skills/<name>/

~/.claude/projects/<encoded-cwd>/*.jsonl                # claude session state (auto)
~/.codex/sessions/                                      # codex session state (auto)
```

**Rules:**
- Real files always in vault. Symlinks always FROM outside-vault INTO vault. Keeps vault self-contained for Obsidian Sync.
- AGENTS.md is the real name (Codex convention). CLAUDE.md is a symlink to AGENTS.md so both agents read the same instructions.
- `notes/` at project root = symlink into vault. Contains `inbox.md` and any per-project markdown.
- `.claude/` and `.codex/` config dirs at code project root — NOT in vault.
- Skills = coding projects. Live at `~/workspace/skills/<name>/`. NOT in vault.
- Coding projects at `~/workspace/<group>/<name>/`. Notes side at `~/workspace/vault/<group>/<name>/`.

## 3. Naming convention (Slack channel → filesystem path)

**Underscore = path separator, hyphen = name segment.**

| Slack channel | Path (vault) | Path (code, if promoted) |
|---|---|---|
| `#foo` | `~/workspace/vault/foo/` | `~/workspace/foo/` |
| `#simple-name` | `~/workspace/vault/simple-name/` | `~/workspace/simple-name/` |
| `#ideaflow_cortex` | `~/workspace/vault/ideaflow/cortex/` | `~/workspace/ideaflow/cortex/` |
| `#blogs_binding-values` | `~/workspace/vault/blogs/binding-values/` | `~/workspace/blogs/binding-values/` |
| `#ideaflow_backend_api` | `~/workspace/vault/ideaflow/backend/api/` | `~/workspace/ideaflow/backend/api/` |

Slack allows underscores. Every `_` becomes a directory boundary. Hyphens stay in the name segment.

## 4. Capture surfaces (MVP: Monologue only)

- **Primary — Monologue (Watch / iPhone / Mac Monologue apps)** → Monologue cloud → cron on AX41 runs `monologue notes all --updated-after <cursor>` every 3 min → each new note becomes a file in `~/workspace/vault/inbox/`. Cursor stored at `~/.local/state/monologue-cursor`.
- **Backup — HTTPS POST endpoint** at `https://95-217-119-40.sslip.io/audio` (already live). Watch Shortcut posts audio directly. Currently unused because Monologue works; kept alive as failover.
- **Pebble Ring** (when arrives ~1 week) → webhook to `/pebble` on AX41 → same downstream.
- **Slack messages / DMs** → bot writes into `vault/inbox.md`.

**No faster-whisper** on AX41 — Monologue does transcription cloud-side.

## 5. Processing pipeline — journalmaxx `/ingest`, extended

journalmaxx already exists on Tejas's Mac and does the classification we need. **Ported verbatim to AX41** as systemd units:

- `journalmaxx-ingest.service` — inotify on `~/workspace/vault/inbox/`, invokes `claude -p -c "/ingest"` on each new file
- `journalmaxx-patterns.timer` — daily pattern-tracker for habit auto-creation
- `/review` slash command in Slack triggers the review flow

**One extension to the `/ingest` prompt:** classifier already emits `journal / todo / idea / atom`. Add category `project-note-for-<x>`. When emitted, ingest also appends atom to `~/workspace/vault/<x>/notes/inbox.md`. Same LLM call, no new pipeline layer.

## 6. Concierge — the Slack bot

**Fork Noos** (`~/workspace/ideaflow/noos/`), strip Neo4j, retarget at SQLite + AX41 filesystem.

- **Transport:** Slack Bolt + Socket Mode (no public URL needed).
- **Session-registry bug fix:** Noos stores `sessionUuidMap` in an in-memory `Map` (`noos/src/slack/claude/sessions.ts:16`) — bot restart loses all thread↔session mappings. First fix: persist to SQLite on every UUID capture.
- **Copy verbatim:** `noos/src/slack/backfill/rate-limit.ts` (40-line token bucket, 15/min); `noos/src/slack/claude/runner.ts:40-151` (abort registry + SIGINT→SIGTERM→SIGKILL ladder + `isAbortMessage` regex).

## 7. Provider layer — Codex default, Claude Code via mention

**Two providers wrapped behind one 3-line interface (per Thinkering v0 `AgentProvider` pattern):**

```typescript
interface AgentProvider {
  id: string;                                            // 'codex' | 'claude-code'
  run(input: {
    prompt: string;
    cwd: string;
    additionalDirs: string[];                            // maps to codex --add-dir
    sessionUUID: string | null;                          // null = fresh
    onProgress?: (event) => void;                        // heartbeat only
  }): Promise<{ text, sessionUUID, toolsUsed }>;
  fork(sessionUUID: string, atMessageIdx?: number): Promise<string>;
}
```

### Codex (default)

- **Transport: persistent WebSocket to `codex app-server`** (JSON-RPC 2.0). Concierge holds ONE connection.
- Wire methods used: `thread/start`, `thread/resume`, `thread/fork`, `thread/rollback`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/goal/set`, `thread/inject_items`.
- Auth: ChatGPT subscription OAuth.
- **No subprocess-per-turn** — one connection, N concurrent threads.

### Claude Code (`@claude-code` bot mention)

- **Transport:** `claude --print --verbose --output-format stream-json --dangerously-skip-permissions [--resume UUID] [--fork-session] <prompt>` — one subprocess per turn.
- Session UUID extracted from `system:init` event in JSONL stream.
- Fork via `--fork-session` (native — confirmed).
- Auth: Claude Pro subscription OAuth.
- **Risk:** Anthropic paused a 2026-06-15 plan to split `--print` off subscriptions. If they flip it, swap to in-process Claude Agent SDK. `AgentProvider` interface makes this a one-file change.

### Thread-to-provider binding

- **Immutable per thread.** First message determines provider.
- **Selection precedence:** `@claude-code` mention (or any specific bot user) > channel default (`channels.provider_default`) > global default `codex`.
- No `#tag` syntax. Bot mentions only.

## 8. Skills — multi-bot pattern

- Each skill = separate Slack app install with a distinct bot user (`@substack-editor`, `@brief-summarizer`, etc.).
- Slack's built-in `@` autocomplete handles discovery.
- Backend routes by which bot was `@`-mentioned. Same provider call, different system prompt / different `~/.agents/skills/<name>/` mounted.
- Skill code lives at `~/workspace/skills/<name>/` (git repo). Symlinked into `~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`.
- **Manual creation for MVP:** no `skills/config/write` API, no auto-scaffolding.

## 9. Data model (SQLite at `~/.local/state/concierge/state.db`)

```sql
CREATE TABLE channels (
  slack_channel_id  TEXT PRIMARY KEY,
  slack_channel_name TEXT NOT NULL,
  group_name        TEXT,                                -- e.g. 'ideaflow' or NULL
  name              TEXT NOT NULL,                       -- e.g. 'cortex' or full if no group
  vault_path        TEXT NOT NULL,                       -- ~/workspace/vault/<group>/<name>/
  code_path         TEXT,                                -- ~/workspace/<group>/<name>/ NULL if not promoted
  additional_paths  TEXT,                                -- JSON array of extra --add-dir paths
  provider_default  TEXT NOT NULL DEFAULT 'codex',
  mode              TEXT NOT NULL DEFAULT 'agent-auto', -- agent-auto | agent-tag | silent
  bot_user_id       TEXT,                                -- which bot handles this channel (multi-bot support)
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_channel_id  TEXT NOT NULL REFERENCES channels(slack_channel_id),
  slack_thread_ts   TEXT NOT NULL,                       -- top-level msg = thread anchor
  provider_id       TEXT NOT NULL,                       -- 'codex' | 'claude-code' — immutable
  agent_session_uuid TEXT,                                -- provider-specific UUID; set after first turn
  parent_session_id INTEGER REFERENCES sessions(id),     -- for forks
  parent_message_idx INTEGER,                             -- for rollback-and-fork
  status            TEXT NOT NULL DEFAULT 'idle',        -- idle | running | error | archived
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_turn_at      DATETIME,
  UNIQUE(slack_channel_id, slack_thread_ts, provider_id)
);

CREATE TABLE turns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        INTEGER NOT NULL REFERENCES sessions(id),
  slack_user_msg_ts TEXT NOT NULL,                       -- triggering user message
  slack_bot_msg_ts  TEXT,                                -- bot reply (edited in place with heartbeat)
  user_text         TEXT NOT NULL,
  agent_text        TEXT,                                -- final assistant reply
  status            TEXT NOT NULL DEFAULT 'queued',      -- queued | running | done | error | cancelled
  started_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at          DATETIME,
  UNIQUE(session_id, slack_user_msg_ts)                  -- idempotency
);
```

## 10. Interactions

**Slash commands:**
- `/new <name>` — vault-only channel
- `/new-code <name>` — coding project channel (vault + code + symlinks)
- `/promote` — convert current vault-only channel to coding project (idempotent)
- `/fork [message-ts]` — fork current thread (from specified message, or current)
- `/add-dir <path>` — additional working directory for this channel
- `/remove-dir <path>`
- `/auth-refresh <provider>` — pty-based re-auth flow
- `/ping` — bot must respond within 3s (liveness)
- `/todo <text>` — append to current channel's `notes/inbox.md` without agent
- `/note <text>` — same

**Message shortcuts (⋯ menu on any message):**
- **Fork thread from here** — `thread/fork` with `atMessageIdx = clicked_message_idx`
- **Send to inbox** — captures message text into `vault/inbox.md`
- **Turn into todo** — appends to a project todo file

**No emoji. No message-content trigger syntax.**

## 11. Turn output (no streaming)

1. User posts message. Bot posts "🧠 working..." reply.
2. Bot dispatches to provider.
3. Every 30s while turn is running, bot edits: "🧠 still working — 2m30s, last update 15s ago, 5 tool calls". **Heartbeat shows elapsed AND last-update-age** so user can distinguish live-but-slow from stuck.
4. Turn completes. Bot parses final assistant text (skipping tool_use blocks). Edits message with final text.
5. Rate limit compliance via Noos's 15/min token bucket. On 429, honor `Retry-After` and post ephemeral warning to user.

## 12. Sync — obsidian-headless as systemd

- `obsidian-sync.service` runs `ob sync --continuous` under systemd.
- Auto-restart on crash. Logs to journal.
- Vault sync is the ONE sync mechanism. Coding projects are NOT synced from Mac (clone git repos independently on each machine).

## 13. Auth summary

| Thing | Where | How refreshed |
|---|---|---|
| Claude Code OAuth | `~/.claude/.credentials.json` on AX41 | `/auth-refresh claude` |
| Codex OAuth | `~/.codex/auth.json` on AX41 | `/auth-refresh codex` |
| Monologue API token | `~/.config/monologue/config.json` | manual (rarely expires) |
| Slack bot tokens (per app install) | `/root/.config/concierge/slack-<app>.toml` (0600) | manual reinstall if revoked |
| Obsidian Sync | `~/.config/obsidian-headless/` | `ob login` re-run |

Cron on AX41 checks each OAuth token daily, posts warning to `#system-status` channel if within 3 days of expiry.

## 14. Deliberately NOT building (yet)

- **faster-whisper on AX41** — Monologue does transcription.
- **HTTPS-POST audio pipeline** as primary — kept as backup.
- **Slack DM-to-self / iPhone-Shortcut-text capture** — Monologue covers voice, direct Slack chat covers text.
- **Slack Canvas** — bots can't read Canvas per Slack API. CLAUDE.md/AGENTS.md lives in vault, editable on iPhone via Obsidian mobile.
- **Slack Lists** — enabled via Pro trial but optional.
- **Router agent in `#inbox`** — auto-classify + auto-route. Deferred. Captures land in `vault/inbox.md`; user promotes manually via slash commands until we have signal.
- **Bot liveness monitoring beyond `/ping`** — `systemctl Restart=always` handles crashes.
- **Image / artifact handling** — implement when first needed.

## 15. Risks

- **Anthropic `--print` metering change** — paused not cancelled. Migration path: swap Claude Code impl of `AgentProvider` to in-process Agent SDK.
- **`obsidian-headless` open beta (v0.0.14)** — instrument logs closely.
- **Noos in-memory session Map bug** — must fix as day-1 fork change.
- **Multi-bot Slack config surface** — N app installs = N OAuth sets. Consolidate past ~10 skills.
- **Long-form Watch capture reliability via Monologue** — 18-min test succeeded, 45-min needs empirical confirmation. Backup: HTTPS-POST direct path works for 36-min.

## 16. Build sequence

See `IMPLEMENTATION.md`.

## 17. Naming

- **Overall bot** = Concierge (`@concierge` in Slack)
- **Skill bots** = named for their function (`@codex`, `@claude-code`, `@substack-editor`), each a separate Slack app
- **Repo/project folder** = `slack-concierge`
- **Codebase language** = TypeScript (matches Noos, matches Slack Bolt SDK)
- **Systemd services on AX41:** `concierge.service`, `obsidian-sync.service`, `monologue-poll.service` + `.timer`, `journalmaxx-ingest.service`, `codex-app-server.service`
