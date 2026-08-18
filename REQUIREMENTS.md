# Agent Control Surface — Live Requirements Log

This is a running list of requirements, questions, and design constraints as they surface during design conversations. **Do NOT delete entries** — mark them as `[promoted]` when they've been added to DESIGN.md's R-list, `[built]` when implemented, `[deferred]` if we consciously punt.

Format: one requirement per section. Newest at top.

Any agent working on this project: append to this file as new requirements come up in conversation. When something is confirmed/decided, mark it and reference the DESIGN.md section it landed in.

---

## 2026-08-05 late evening — after research pushback + more requirements

### `[open]` Heartbeat is MANDATORY, not optional
Every long-running turn must post progress updates so the user can distinguish "still working" from "died." Heartbeat should show BOTH elapsed time AND time-since-last-heartbeat, so if last heartbeat was e.g. 90s ago the user knows something is stuck. Format: "🧠 working — 2m 30s elapsed, last update 15s ago, 5 tool calls".

### `[open]` Bot liveness — how do we know the bot itself is alive
Distinct from agent-subprocess liveness. Need a way to see if the Bolt+Socket-Mode connection is up and the bot process is healthy. Options: a `/ping` slash command that MUST reply within 3s (Slack will show timeout if not); a heartbeat channel `#bot-status` where bot posts its uptime every hour; systemd healthcheck we can query. Design: probably all three, cheap.

### `[open]` Image / artifact handling
When agent produces an image, chart, PDF, screenshot, etc., it should surface as an attachment / thumbnail in the Slack thread. Not just a file path. Design: agent writes artifacts to `<cwd>/.artifacts/` with a well-known naming convention → bot post-processing scans that dir after each turn → uploads via `files.upload` API → posts thumbnails in reply. Needs `files:write` scope.

### `[open]` Rate-limit VISIBILITY
When Slack throttles us (429 response) — user MUST know. Design: bot posts a `⚠️ Slack rate-limited, retry in 30s` ephemeral message (visible only to user, not channel noise). Also: metric logged; if throttling recurs, escalate to a persistent alert.

### `[promoted → R14]` Bot creation / skill scaffolding tool
Easy way to define and create new bots + attach skills. Design: `agent-surface skill new <name>` CLI on AX41 that (a) creates `~/agent-surface/skills/<name>/{SKILL.md,cloud.md,scripts/}` scaffold, (b) prints out the exact steps to register a new Slack app + bot user + copy the tokens back, (c) restarts the bot process to pick up the new skill. Ideally the Slack app creation is API-automated but Slack's app creation API is limited — some manual steps unavoidable.

### `[open]` Slash commands for automation (not skills)
Slash commands stay as our toolbox for meta-actions (not for skill invocation which is the multi-bot mention pattern). Currently designed: `/auth-refresh <provider>`, `/ping`, `/todo`, `/switch-provider`, `/create-channel`, `/mode <agent-auto|agent-tag|silent>`.

### `[open]` Mid-conversation todo capture, no agent turn
When talking with an agent, sometimes an unrelated todo comes up. Want to add it to a todos file without triggering a new agent session or interrupting the current one. Options ranked:
- `/todo <text>` slash command — cleanest. Appends to `<cwd>/TODOS.md` OR `<cwd>/sessions/<currentSessionId>/TODOS.md`. Bot replies with a confirm reaction on the slash-command message.
- 📝 emoji reaction on any message — adds that message's text as a todo.
- `!todo <text>` inline prefix — bot detects and appends WITHOUT invoking agent.
Design: support all three, they're all cheap. Default is `/todo`.

### `[open]` Also — bypass agent-auto mode for JUST some messages
Even in an `agent-auto` channel, sometimes I want to send a message that ISN'T an agent invocation — a "note to self" style capture. Options: prefix `!note <text>` → append to NOTES.md without invoking agent. Same escape hatch as todo. Trivial addition.

---

## 2026-08-05 evening — after the "how does this all work" pushback

### `[promoted → R10]` No streaming to Slack, wait for full response
Tejas: "we're not going to be streaming our responses here we're obviously going to keep waiting until it has a response". Drop RunBroker. Text-only, tool-calls skipped, heartbeat every 30s for liveness only.

### `[promoted → R13]` Per-channel mode: agent-auto / agent-tag / silent
Not every channel should invoke agents on every message. Some are quick-capture (append-only). Some are project (agent every message). Some are silent scratchpads.

### `[promoted → R14]` Skill invocation via multi-bot pattern
Each skill = its own Slack bot user. Slack's `@` autocomplete does discovery for free. Way better than slash commands or inline `!skill` syntax.

### `[built] [promoted → R15]` Quick capture from Watch / iPhone / Pebble
Watch-recorded voice → iCloud → transcribed (whisper) → Slack `#inbox`. iPhone Shortcut → Slack API direct. Pebble Index 01 posts its phone-generated transcript to the authenticated `/pebble` route, which durably queues it to the configured `#slack-inbox` destination before acknowledging. All routes are declared in `config/capture-routes.toml`; paths, authentication, limits, and destinations are not embedded in the server implementation.

### `[promoted → R16]` Agent-created channels
User in-thread: "hey split this into its own channel" → agent calls `conversations.create` → mkdir → replies with link. Needs `channels:manage` scope.

### `[promoted → R17]` Long-running processes via tmux convention
When agent runs a dev server, use `tmux new-session -d -s <name>` so it survives the claude subprocess exit. Track in `<cwd>/.processes.json`. Convention documented in each channel's CLAUDE.md.

### `[promoted → R18]` Auth refresh from Slack, no SSH
`/auth-refresh <provider>` spawns `claude auth` in a pty on AX41, bot posts URL, user opens on phone, gets code, replies in same thread, bot pipes code to waiting pty.

### `[promoted → R19]` Continuous requirements capture in this file
As new requirements surface in conversation, land here first, promote to DESIGN.md R-list when ready.

### `[open]` No HA / alerting overkill for personal box
Tejas: "worst case scenario is I can SSH into the machine from my phone". Drop Telegram alerts, drop external ping. Keep `systemctl Restart=always` — free.

### `[open]` Docker on AX41: do we even need it?
Docker's been nuked. Question: do any of Tejas's use cases actually need it? Small LLMs can run native. Hobby demos can run native. Cortex-style container isolation is not needed for personal dev. **Recommendation: leave docker installed but don't enable it. Turn on if a specific project needs it.**

### `[REJECTED]` The "iCloud → AX41" bridge for voice capture (via laptop)
Original design punted to "laptop-side transcription for MVP". Tejas rejected: laptop can't be always-on middle. Need direct Watch→AX41 route with no laptop dependency. Research dispatched 2026-08-05 late evening (see `scratchpad/agent-surface-research/watch-to-server.md` when it arrives) to find real answers on: iCloud direct from Linux, Watch→HTTP direct, push-notification relays, Watch→Slack direct.

### `[open]` `#inbox` router: forward-only vs also-invoke
Some captures are "file this" (forward-only), some are "act on this" (forward AND kick off a session in the target folder). Might need two inbox channels (`#capture`, `#do`) OR a per-message flag ("act on this ↑" reaction to trigger). Design later.

---

## 2026-08-05 afternoon — the initial requirements list

All promoted to R1-R12 in DESIGN.md at doc creation time.

- Channel = folder
- Message = session
- Thread reply = resume
- No @-mention needed
- Bot auto-joins new channels
- Optional @-skill tags
- Editable per-channel instructions (Canvas ↔ CLAUDE.md)
- Auth via Claude subscription
- Session transcripts on disk, not Slack
- Text-only UI (no tool-call spam)
- Daily digest
- Escape to Cortex workspace if needed
