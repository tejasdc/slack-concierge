# Slack Concierge — Extracted Requirements (Canonical)

**Extracted:** 2026-08-05 from transcript `1a9cbe29-2afb-4bd0-9269-7272cf5c9b9d.jsonl` + DESIGN.md + IMPLEMENTATION.md + REQUIREMENTS.md + `tmp/reviews/codex-review-1.md`.

**Purpose:** authoritative list of what Slack Concierge must do. Every entry is quoted or tight-paraphrased from Tejas's own words. Rejected simplifications kept in Section 2 to prevent backsliding. Line refs like `L716` = line in the JSONL transcript.

---

## 1. Confirmed requirements (build & test today)

### 1.1 Slack channel / session / thread model

- **R-CHAN-1 — Channel = folder.** "Every time I think of a new project, I just create a new channel right? The new channel means a new folder gets created inside my machine" (L609). Test: create Slack channel `#foo` → `~/workspace/vault/projects/foo/` exists on AX41. (**Namespace clarification 2026-08-07:** all bot-created dirs live under `vault/projects/`, never at vault root — top-level of vault is reserved for Tejas's own hand-organized notes.)
- **R-CHAN-2 — Message = new session.** "For now let's create every new message could be in a new session that gets created in that folder" (L609). Test: post top-level message in `#foo` → new session/thread mapping row exists in state.db, agent invoked with `cwd = <channel folder>`.
- **R-CHAN-3 — Thread reply = resume that session.** "Responding to thread is resuming or continuing that session. So a message sent in thread is on each session and I would want information coming back from the agent for that" (L609). Test: reply in same thread → provider resumed with prior `sessionUUID`; UUID persists across bot restart (state.db, not in-memory map).
- **R-CHAN-4 — No @-mention required.** "The assumption is every message is going to be invoking agents in starting sessions or resuming sessions or continuing the thread. I don't know how to...I should not basically tagging" (L609). Also L2012: "why does it say mention add concierge to start an agent on? Why do you have to mention that". Test: message without `@concierge` mention triggers agent turn.
- **R-CHAN-5 — Bot auto-joins new channels.** "How will it know when a new channel is created? By definition that bot won't be part of that new channel right so how does automation work for new channel creation" (L615). Test: create channel via Slack UI → bot receives `channel_created` → invites itself; sending a message immediately works.
- **R-CHAN-6 — Bot invites the USER on `/new`.** "I did create a new channel it's called hello world and i had to join that channel but if it would be nicer if that actually adds my channel with unjoins me" (L2012). Test: `/new hello-world` → user is auto-invited to the created channel.
- **R-CHAN-7 — Channel-name → path convention.** Slack allows `_` and `-`. Underscore = directory separator, hyphen = segment name (DESIGN §3). `#ideaflow_cortex` → `~/workspace/vault/ideaflow/cortex/`. "we might need a new connection to name something maybe an underscore" (L1238). Test: create `#ideaflow_cortex` → correct nested path exists.
- **R-CHAN-8 — Multi-hierarchy support.** "what if i need multiple hierarchies?" (L1238). Test: `#a_b_c_d` → `~/workspace/vault/a/b/c/d/`.
- **R-CHAN-9 — Agent-created channels.** In-thread request "hey split this into its own channel" → bot creates channel + folder + posts link. Needs `channels:manage`. REQUIREMENTS.md R16. Test: from within a thread, agent tool call creates a new Slack channel + backing folder.
- **R-CHAN-10 — CWD is per-channel; agent can extend with additional dirs.** "if an agent creates a CWD the session CW should be applied to all of the other sessions that is created in channel 2 not just that one session" (L1238). "CWDU is per channel but you have to understand you can have multiple CWDS. The agent should be able to add multiple folders" (L1283). Test: agent adds a `additional_paths` entry via `/add-dir`; new session in same channel receives that dir.
- **R-CHAN-11 — Session-transcript persistence lives on disk, not Slack.** "all of the session history and session data was going to be stored in my machine anyways, in transcript files" (L609). Test: full agent JSONL exists at provider-specific path (`~/.codex/sessions/…`) after a turn.

### 1.2 Slash commands (every one asked for)

- **R-SLASH-01 — `/ping`** — MUST reply within 3s. REQUIREMENTS.md `[open]` — "a `/ping` slash command that MUST reply within 3s (Slack will show timeout if not)". "Okay i got a pong let's proceed" (L1891). Test: send `/ping`, receive pong within 3s.
- **R-SLASH-02 — `/new <name>`** — creates vault folder + AGENTS.md + notes/inbox.md + auto-invites user. Simplified (from `/new` + `/new-code`) per L1891 pushback: "why are these slash commands for new code what is new code?". Consolidated single command: always creates both vault + code + symlinks (per continuation-summary "Simplified to just /new (always creates both vault + code with git init)"). Test: `/new hello-world` → vault + code dirs + git init + symlinks + Slack channel created + user invited.
- **R-SLASH-03 — `/promote`** — convert vault-only channel to coding project (mkdir + git init + symlinks). Idempotent. DESIGN §10. Also R-CHAN-11-EARLY-CODE: "maybe we should have a way Start a coding project from the beginning itself because some ideas are coding projects so I do not want to wait until everything" (L1283). Test: run `/promote` in vault-only channel → code dir created, symlinks in place, repeat is no-op.
- **R-SLASH-04 — `/fork [message-ts]`** — fork thread from clicked message, or current message. "I want to be able to fork sessions... I want quickly be able start a new session which is a fork or branched version in the previous session" (L1238). "I need fork on the day one, understand this" (L1584). "Okay that's great! So I think we can implement the fork /fork/ command here so I can let go from any session and then have new fork created and I can continue there" (L1283). Test: `/fork` in thread → new thread pointer + provider `thread/fork` call; forked session diverges cleanly.
- **R-SLASH-05 — `/add-dir <path>`** — add additional working dir for channel. DESIGN §10. Test: adds path to `channels.additional_paths`; agent sees the dir on next turn.
- **R-SLASH-06 — `/remove-dir <path>`** — inverse. DESIGN §10. Test: removes path; agent no longer sees it.
- **R-SLASH-07 — `/auth-refresh <provider>`** — pty-based re-auth flow via Slack (no SSH). "instead of SSHing from my phone can we not have some sort of an automation or login flow from the slack app itself so we can send a message or like you know yeah send a command and like that kind of run a script that script could just literally run give me the login link" (L723). "yeah lets put the authentication as a thing as a slash command in the design here so we can do that for both claude and codex" (L801). Test: `/auth-refresh codex` → bot posts URL; user replies with code; bot pipes to waiting pty; new tokens saved.
- **R-SLASH-08 — `/todo <text>`** — append todo to `<cwd>/TODOS.md` (or session-scoped) WITHOUT invoking agent. "sometimes I think of a todo item that I don't necessarily want to do right away So I wanna be able to add a todo items for that particular project or even for that session And that could happen without the agent just like piping that message to a file or something" (L801). REQUIREMENTS.md mid-conversation todo. Test: `/todo pick up milk` in `#foo` → line appended to `~/workspace/vault/foo/notes/inbox.md`, no agent turn, bot posts confirm.
- **R-SLASH-09 — `/note <text>`** — same semantics as `/todo`, different filename. Test: `/note remember X` → appended, no agent turn.
- **R-SLASH-10 — `/switch-provider <codex|claude-code>`** (REQUIREMENTS.md early list). Test: switches channel default provider; next new thread uses it. NOTE: also see R-PROV-2 immutable-per-thread.
- **R-SLASH-11 — `/create-channel`** (REQUIREMENTS.md early list — appears equivalent to R-CHAN-9 agent-side channel creation).
- **R-SLASH-12 — `/mode <agent-auto|agent-tag|silent>`** — set channel mode (see R-MODE-1). REQUIREMENTS.md.

**Rejected simplifications (Codex wanted to kill `/fork`, `/add-dir`, `/remove-dir`, `/auth-refresh`, `/todo`, `/note`, `/promote`). Tejas rejected all of them (L1584).**

### 1.3 Message shortcuts (⋯ menu on any message)

- **R-SHORT-1 — "Fork from here"** — right-click any message → `thread/fork` with `atMessageIdx`. "I also really like this thread rollback but I don't know how do you make this happen? How do you point any message and then say can we add a drop down menu item for any message to roll back and start a thread from there" (L1283). Test: click shortcut on message N → new thread starts from message-idx=N.
- **R-SHORT-2 — "Send to inbox"** — captures message text into `<cwd>/notes/inbox.md`. DESIGN §10. Test: click on any message → text appended to inbox.md.
- **R-SHORT-3 — "Turn into todo"** — appends to project todo file. DESIGN §10. Test: click on any message → appended to TODOS.md.

**No emoji reactions as primary triggers.** "I'm not gonna be doing any emojis and all of that bullshit" (L1283). DESIGN §10.

### 1.4 Agent providers (Codex + Claude Code, pluggable)

- **R-PROV-1 — Two providers behind one interface.** Codex + Claude Code, wrapped in `AgentProvider`. "But yes I already need this... Everything that we build should have proper abstractions and proper interfaces because ibus should be able to like plug in plug out put in throw out anything I want no dependencies should be so tightly wired that we're attached to it" (L1584). Test: swap providers via config with zero code changes.
- **R-PROV-2 — Codex is the default provider.** "I guess we can start with codex being a default provider and use the app server and things like that" (L859). Test: new channel with no override → codex.
- **R-PROV-3 — Claude Code invoked via bot @-mention.** "Cloud code could be via bot or tagging you so you might have to support based on the message" (L859). "we don't think we need thread having parallel codec sessions at all. A thread has to be similar I'm not going to tagging a fucking cloud agent for every message I am sending in a thread. When I send a message in codex. If I add the cloud tag then that whole thread has to be through the same agent" (L865). Test: mention `@claude-code` in top-level message → entire thread uses claude-code (immutable per thread).
- **R-PROV-4 — Thread-to-provider binding is IMMUTABLE.** DESIGN §7 + L865. Test: switching mid-thread rejected/ignored.
- **R-PROV-5 — Authentication via CLI OAuth (subscription plan, NOT API billing).** "I don't think we can use Agent SDK because that means Agent SDK also uses API billing so I don't think thats a solution" (L859). "we can login through my subscription plan" (L609). Test: no API keys anywhere in Concierge config; provider uses `~/.claude/.credentials.json`, `~/.codex/auth.json`.
- **R-PROV-6 — Support Anthropic pausing `--print` in future.** "As far as I remember, Anthropic was also trying to remove Cloud Print mode or make it not part of subscription plan so thats going to be dangerous for us... lets do some research so we can think about preemptively how we can avoid those things" (L801). Test: interface allows swap to in-process Agent SDK impl without touching Slack layer.
- **R-PROV-7 — Codex must use the proper runtime, NOT `codex exec`.** "Wait, why does your scenario read that codex exec is used? Did we fucking read the documentation to see that we don't have to use codexexec and they have a whole runtime that we wanted to use" (L1164). NOTE: implementation later reverted to `codex exec --json` subprocess when app-server didn't work (continuation summary). Test: whichever transport ships, session IDs are extracted correctly and forkable.
- **R-PROV-8 — Fork must work day-one for Codex.** "I need fork on the day one, understand this" (L1584). Test: `/fork` from any Codex thread → new thread, agent history preserved to fork point.
- **R-PROV-9 — Fork research for Claude Code.** "hey cloud code doesn't have four commands? That sounds sketchy... Let's do some basic research but its ok because codex is going to be our main agent here" (L1283). Test: document whether `claude --fork-session` works.

### 1.5 Vault, code project structure, symlinks

- **R-VAULT-1 — One workspace root: `~/workspace/`.** "I'm pretty sure i mentioned that i use a workspace I train my route / workspace" (L1181). Test: everything lives under `~/workspace/` on AX41.
- **R-VAULT-2 — Real files in vault; symlinks from outside INTO vault.** "we should probably should walk through what happens when we create a new channel..." (L1231). DESIGN §2. Test: `ls -la ~/workspace/ideaflow/cortex/AGENTS.md` shows symlink into vault; vault contains the real file.
- **R-VAULT-3 — AGENTS.md is the real file, CLAUDE.md is a symlink to it.** "agents.md and cloud.mdd should absolutely be symlinks so we only update once one file in our system" (L1220). Test: editing AGENTS.md via Obsidian → CLAUDE.md reflects change (same file).
- **R-VAULT-4 — `notes/` at project root is symlink into vault; contains `inbox.md`.** DESIGN §2. "add let's just start an inbox folder right inbox.md instead of journal.mdd so essentially every workspace every project everything gets an inbox" (L1220). Test: `notes/` in code project is symlink; write to it lands in vault.
- **R-VAULT-5 — `.claude/` and `.codex/` config dirs at code project root are NOT in vault.** DESIGN §2 (code-side config, not synced).
- **R-VAULT-6 — Coding projects live OUTSIDE the vault when promoted.** "slack channel path mapping everything basically should you know reside inside my obsidian vault right unless it's a coding project then it gets promoted to outside of the vault" (L1220). Rationale: don't want code inside Obsidian sync. Test: after `/promote`, `~/workspace/<group>/<name>/` exists at same path as vault mirror, only `notes/` + AGENTS.md are symlinks.
- **R-VAULT-7 — Blogging projects treated the same.** "the same thing in the sense that all of the coding All of the agent sessions start at their root but everything gets linked into the Obsidian Vault instead of having the agents be inside the Obsidium folder" (L1181). Test: `#blogs_binding-values` → both `~/workspace/vault/projects/blogs/binding-values/` and `~/workspace/blogs/binding-values/` if promoted. (Vault side under `projects/` namespace per 2026-08-07 clarification.)
- **R-VAULT-8 — Skills live at `~/workspace/skills/<name>/`, NOT in vault, and are symlinked into `~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`.** "Wait i don't know if we need skills inside the vault here skills is basically you can think of it as just a different coding project" (L1231). "all of our skills that we create will be added to dotagents folder and then get sim linked into other agents folders" (L1220). Test: newly-created skill via Slack channel is visible in all three agent skill dirs.
- **R-VAULT-9 — Layout mirrors the Mac workspace layout.** "essentially what to do there or add there... build a pretty similar environment. We have today here" (L1410). Test: `~/workspace/` on AX41 mirrors `~/workspace/` on Mac (structure, not necessarily content).

### 1.6 Obsidian sync

- **R-OBS-1 — Obsidian Sync (paid subscription) is the sync mechanism, NOT git, NOT rsync.** "I have the Obsidian Sync subscription already So we need to decide between using sync options versus building our own backup solution and whatnot" (L929). "I think for the most part I think there's no need for over complication" (L929). Test: file created on Mac Obsidian appears on AX41 within seconds; reverse works.
- **R-OBS-2 — obsidian-headless (`ob` CLI) runs as systemd on AX41.** "the Slack bot which is like connecting you like in work to this agent should be really well written or where the service should be something that is like always running if it kills you understand how in a macOS you can create a launch agent which gets renewed every time its killed right? We need things like that. PM2 services all of those for things" (L1584). DESIGN §12 obsidian-sync.service with `Restart=always`. Test: `systemctl status obsidian-sync` shows active; kill it → auto-restarts.
- **R-OBS-3 — One vault synced 3-way (AX41, Mac, iPhone).** DESIGN §1. Test: create file via Slack agent on AX41 → visible on iPhone Obsidian within seconds.
- **R-OBS-4 — Coding project code is NOT synced; only vault content.** DESIGN §12. "coding projects are NOT synced from Mac (clone git repos independently on each machine)".
- **R-OBS-5 — Merge existing older vault into journalmaxx vault.** "I went into my obsidian vault for journal max and turned on sync there and i said merge" (L1336). Test: after merge, both vaults' content present, no duplicate loss.

### 1.7 Monologue voice capture

- **R-MONO-1 — Monologue is the primary voice-capture surface (Watch, iPhone, Mac).** "for now let's just like do auto routing... let's just still keep the monologue for now" (L865, L1220). Test: dictate note on Watch via Monologue → shows up on AX41 in inbox within 3 min.
- **R-MONO-2 — Monologue CLI polls every 3 min.** DESIGN §4, IMPLEMENTATION Phase 3. Test: `systemctl list-timers | grep monologue-poll` shows every 3 min.
- **R-MONO-3 — Cursor stored at `~/.local/state/monologue-cursor`.** DESIGN §4. Test: crashes / restarts don't lose or duplicate notes. **Codex flagged as risk (advances cursor to "now" is lossy) — must fix before shipping.**
- **R-MONO-4 — Notes land as files in `~/workspace/vault/inbox/`.** DESIGN §4. Test: new Monologue note = new `.md` file in that dir with YAML frontmatter.
- **R-MONO-5 — No faster-whisper on AX41.** Monologue does transcription cloud-side. DESIGN §4. Rationale L859: "Whisper is free! Why would you pay for something?". Actually he wants NO paid Whisper — Monologue is his existing paid path.
- **R-MONO-6 — Backup path: HTTPS POST to `https://95-217-119-40.sslip.io/audio` still lives.** "still keep the monologue for now I was just testing that path so it's good that direct posting also works but let's stick with monologue if we see any issues then we can switch out" (L1220). Test: HTTPS POST from Watch shortcut lands file on server (this already works with 36-min recording — L1208).
- **R-MONO-7 — Long recordings work (30-45 min).** "I record thirty minutes of audio on my watch And can the shortcut actually upload this file?" (L929). 18-min tested via Monologue (L1139), 36-min via HTTPS POST (L1208). Test: 30-min Watch note ends up as one file, complete transcript.

### 1.8 journalmaxx `/ingest` pipeline

- **R-INGEST-1 — Journalmaxx ported to AX41 as systemd unit.** DESIGN §5, IMPLEMENTATION Phase 4. "the whole journal max thing has to be ported over there so it can start running" (L1164). Test: `systemctl status journalmaxx-ingest` active; new file in `vault/inbox/` triggers ingest.
- **R-INGEST-2 — Classifier already emits `journal / todo / idea / atom` — DO NOT reinvent.** "why do you have a classifier? Do you even understand how... How general max is working? Do you even understand how generalmax is working what the fuck is a classifier? The agent in general maxis is already doing the classification right look through the ingest command" (L966). Test: `/ingest` used verbatim except for the ONE extension.
- **R-INGEST-3 — Add category `project-note-for-<x>`.** When emitted, append atom to `~/workspace/vault/<x>/notes/inbox.md`. DESIGN §5. "i can just add a note saying hey let's make a note about this project and then it should be your note" (L1220). Test: dictate "note about ideaflow-cortex: try zram config" → atom appears in `vault/ideaflow/cortex/notes/inbox.md`.
- **R-INGEST-4 — inotify watcher (Linux replacement for fswatch).** IMPLEMENTATION Phase 4. Test: `apt install inotify-tools`; inotifywait triggers on new files.
- **R-INGEST-5 — Preserve "never delete inbox files until raw body verified in daily note" invariant.** From Codex review RISKS §. Existing safety-preserving behavior. Test: crash during ingest → source file still present, next run reprocesses.
- **R-INGEST-6 — Atomic writes (tmp + rename) into watched inbox path.** From Codex review RISKS §. Test: partial writes never observed by watcher.
- **R-INGEST-7 — `/review` slash command triggers review flow.** DESIGN §5. Test: Slack `/review` fires the daily review pipeline.
- **R-INGEST-8 — Daily pattern-tracker timer.** DESIGN §5 `journalmaxx-patterns.timer`. Test: runs once daily, produces habit auto-creation output.

### 1.9 Canvas + Lists integrations

- **R-CANV-1 — Slack Canvas per channel is where AGENTS.md/CLAUDE.md renders.** "The ideal platonic idea would be me being able to see what the instructions for that folder are and edit it right?" (L609). "canvas for now could just be the cloud.md or the agents.mdf file" (L1220).
- **R-CANV-2 — Deterministic bidirectional sync (Canvas ↔ AGENTS.md).** "how do we make sure that every cloud.md updates actually get reflected? You know not like in a way that we instruct the agent I think that's gonna be too reliable it has to be deterministic That they kept in sync is that possible if that's possible then maybe $7 could make sense" (L615). Test: edit Canvas via iPhone → AGENTS.md changes on AX41; edit AGENTS.md on AX41 → Canvas updates. NOTE Codex reviewer said Canvas API doesn't support agents reading — Tejas insists (L1584) "slack list is hand canvas most important thing".
- **R-CANV-3 — Canvas one-way fallback.** "yeah canvas sync is basically i mean it's fine if he can't read it because it's going to be just one way i just want to visualize what's in the folder or what's on the thread" (L1164). Test: at minimum, agent-side writes render as visible Canvas.
- **R-LIST-1 — Slack Lists for structured project todos.** "start using the list feature for now and then if the list does not work then we can kind of like now upgrade to Canvas" (L1220). "slack list is hand canvas most important thing because I want to experience how it feels like" (L1584). Test: `/todo` items appear in per-channel Slack List.
- **R-LIST-2 — Agent read+write to Lists.** "if agents can read and write then I think we should use that because then I can directly modify the list and add things in there and get the kind of track things and also have a way to sync that with the agents here" (L1164). Test: agent can read Slack List content and write new items via API.
- **R-LIST-3 — Slack Pro trial is in use.** "I have this lab free trial for pro subscription let's use that see how things work" (L1119).

### 1.10 Image / artifact handling

- **R-ART-1 — Agent-produced images/PDFs/charts/screenshots appear as attachments/thumbnails in-thread.** "I would still want to save this file to my icloud right as a backup... sometimes I do see like if the agent gives me an image or something they show that image right like there as a thumbnail. And I should be able to do that as well because otherwise like I won't be able access my images in the folder" (L801, L865). "image and artifact handling most important i'm not going to use this app if its a purely degenerated third tier, lower tier experience than my other apps" (L1584). Test: agent writes chart.png → thumbnail appears in Slack thread reply.
- **R-ART-2 — Convention: random-token, turn-owned `<cwd>/.artifacts/turn-<turn-id>-<ownership-token>/` staging directory.** REQUIREMENTS.md R19. Test: after overlapping turns in one project, the bot records and uploads each turn's own regular files only, rejects symlinks, and durably retries or parks Slack upload failures.
- **R-ART-3 — Requires `files:write` scope.** REQUIREMENTS.md.

### 1.11 Multi-bot / skills scaffolding

- **R-BOT-1 — Each skill = separate Slack app with distinct bot user.** "yeah channel as skill selector is fine but also like you know why can't we have bots? We literally can create bots and use it to tag right? Why is there not an option you specified here?" (L723). "yeah I think we need multi bot approach and we need easy way to define our define and create new bots and attach new skills to those things so that should be part of our design creating new agents to create new skills" (L801). Test: `@substack-editor` mention routes to substack skill's system prompt + skill dir mount.
- **R-BOT-2 — Slack's built-in `@` autocomplete discovers skills.** DESIGN §8. Test: typing `@` in Slack shows all installed skill bots.
- **R-BOT-3 — Substack editor skill exists TODAY and must be invocable.** "I already have a substack editor skill that I use I want to be able to invoke that That's the whole point" (L1584). Test: `@substack-editor` produces a substack draft in `~/workspace/vault/<channel>/`.
- **R-BOT-4 — `agent-surface skill new <name>` (or equivalent) scaffolds new skill.** REQUIREMENTS.md R14: creates `~/agent-surface/skills/<name>/{SKILL.md,cloud.md,scripts/}`, prints Slack app registration steps, restarts bot to pick up. Test: run command → skill dir created + Slack registration prompted.
- **R-BOT-5 — Skill code = separate coding project (with scripts/).** "skills can have scripts and stuff so I don't know if you want to include that inside the Obsidian Vault here but yeah essentially if I have a skills channel in my slack then I should be able to create new skills add new skills upgrade skills from there" (L1220).

### 1.12 Channel modes (per-channel behavior config)

- **R-MODE-1 — Three per-channel modes: `agent-auto` (default), `agent-tag`, `silent`.** REQUIREMENTS.md R13 promoted. "we can have a channels mode thing and yeah we configure it separately for now agent auto is fine" (L801). "some captures are 'file this' (forward-only), some are 'act on this' (forward AND kick off a session)" (REQUIREMENTS.md `#inbox` router). Test: `agent-auto` fires agent on every message; `agent-tag` only when bot mentioned; `silent` never fires (append-only).
- **R-MODE-2 — Bypass agent-auto with `!note` and `!todo` inline prefixes.** REQUIREMENTS.md `[open]`. Test: `!note something` in `agent-auto` channel appends to NOTES.md without invoking agent.

### 1.13 Quick capture from Watch / iPhone / Pebble

- **R-CAP-1 — Watch shortcut (existing) records audio → HTTPS POST direct to AX41 backup path.** Works (L1208 36-min proven). Test: Watch record → server file exists.
- **R-CAP-2 — iPhone Shortcut → Slack API direct.** REQUIREMENTS.md R15. Test: shortcut posts to Slack via `chat.postMessage`.
- **R-CAP-3 — Pebble Ring integration [built]** — Pebble Index 01 transcript-only webhook to authenticated `/pebble` on AX41. The route persists a deduplicated event before returning `202`, retries Slack delivery durably, and sends to the route's configured destination. "yeah pebble i'm gonna get my pebble in a week or something so we can start using that" (L859). "A pebble ring we can add in later" (L1584). Test: authenticated Pebble multipart payload reaches the configured Slack channel; invalid auth/audio/oversized payloads fail closed.
- **R-CAP-4 — All captures land in `#inbox` or `vault/inbox.md`; router forwards later. [built for Monologue + Pebble]** The live Monologue poller and the configured Pebble route both post to `#slack-inbox`; the webhook destination is route data rather than implementation code. DESIGN §14. Test: any capture surface lands in canonical inbox first.

### 1.14 Turn output (no streaming, heartbeat only)

- **R-TURN-1 — No streaming of intermediate output to Slack.** "we're not going to be streaming our responses here we're obviously going to keep waiting until it has a response so we need to understand the whole cloud CLI response format. And like I said, we're gonna be skipping a lot of CLI and tool calls" (L716). REQUIREMENTS.md R10. Test: user sees "working…" placeholder then final text, no per-token stream.
- **R-TURN-2 — Heartbeat is MANDATORY, not optional.** "let's do add a heartbeat here let's not make it optional" (L801). REQUIREMENTS.md `[open]` heartbeat. Test: heartbeat visible every ≤30s.
- **R-TURN-3 — Heartbeat shows BOTH elapsed time AND time-since-last-heartbeat.** "not just how much time has elapsed but also when was the last update so I know if the update has not been done for sometime then the process has died or something" (L801). Format: "🧠 working — 2m 30s elapsed, last update 15s ago, 5 tool calls". Test: heartbeat string contains both durations.
- **R-TURN-4 — Final answer edits placeholder OR posts as new message.** DESIGN §11 says edits placeholder. Codex flagged RED: `chat.update` fails > 4000 chars — must post as new message when long. Test: long agent response (>4000 chars) posts as new thread message, not truncated.
- **R-TURN-5 — Skip tool_use blocks in text parsing.** Only show assistant text. L609, L716. Test: agent tool calls do NOT appear in Slack reply text.
- **R-TURN-6 — 15-msg/min token-bucket rate limit (copied verbatim from Noos).** DESIGN §11. Test: burst >15 msg/min → deferred, not dropped.
- **R-TURN-7 — On 429 from Slack, post ephemeral warning + honor Retry-After.** REQUIREMENTS.md `[open]` rate-limit visibility: "user MUST know. Design: bot posts a `⚠️ Slack rate-limited, retry in 30s` ephemeral message". Test: simulated 429 → user sees ephemeral warning; retry happens per Retry-After.

### 1.15 Health, monitoring, auto-restart

- **R-HEALTH-1 — Bot process runs under systemd with `Restart=always`.** DESIGN §16 concierge.service. "PM2 services all of those for things" (L1584). Test: `kill -9` the process → systemd restarts within 5s.
- **R-HEALTH-2 — Bot liveness via `/ping` (in-band).** REQUIREMENTS.md `[open]`. See R-SLASH-01.
- ~~**R-HEALTH-3 — Bot liveness via heartbeat channel `#bot-status`.**~~ **REMOVED 2026-08-07.** Tejas's reasoning: "silence = down = you notice. I don't need a whole channel for that. If bot is down = no response to my message. That IS the signal." `/concierge-status` slash command reports uptime on demand. No dedicated heartbeat channel.
- **R-HEALTH-4 — systemd healthcheck queryable.** REQUIREMENTS.md `[open]`. Test: `systemctl is-active concierge.service`.
- **R-HEALTH-5 — Socket Mode zombie failure MUST be guarded (Noos health-watchdog pattern).** Codex review RISKS §: Noos observed 9.5h stuck connection. Test: watchdog detects stuck Socket Mode within X minutes and restarts.
- **R-HEALTH-6 — Daily OAuth expiry check → post warning to `#system-status`.** DESIGN §13. Test: mock expiring token → warning posted 3 days before expiry.
- **R-HEALTH-7 — NO telegram alerts, NO external ping.** REQUIREMENTS.md `[open]`: "worst case scenario is I can SSH into the machine from my phone. Drop Telegram alerts, drop external ping. Keep systemctl Restart=always — free". "I don't understand what no HA on AX41 needs What is needing auto restart plus external ping plus telegram alert what is all that? Why do we need that?" (L609).

### 1.16 Continuous requirements capture

- **R-REQ-1 — Requirements land in REQUIREMENTS.md as they come up.** REQUIREMENTS.md preamble R19 promoted. "we also have to keep capturing requirements as i get them so we need a way for that how do I keep caching requirements that is truly my workflow that we can enable later" (L716). Test: as agent conversations produce new requirements, they get appended here.
- **R-REQ-2 — Design docs live at project root, get iterated with review.** "it could be useful for you to actually write out the detailed design and implementation plan and get it reviewed by Codex before we go ahead so we can iterate on that" (L1397). Test: DESIGN.md exists; codex review exists; iteration reflected in R-list.

### 1.17 Infrastructure — AX41 dedicated server

- **R-INFRA-1 — AX41 (Ryzen 5 3600, 64GB RAM, 2× 512GB NVMe RAID1) at `95.217.119.40`.** Explicitly chosen over CCX23 (L374, L471). Test: uname/lscpu on the host matches.
- **R-INFRA-2 — Ubuntu 24.04 on AX41.** DESIGN §1.
- **R-INFRA-3 — zram at 1× RAM for now (increase to 2× later if memory is trashed).** "let's keep it at 1x we don't need 2x for now but i yeah i mean later we can think about when would we know that we need 2X" (L540). Test: `zramctl` shows 1× capacity.
- **R-INFRA-4 — Docker NOT enabled by default; leave installed for opt-in.** REQUIREMENTS.md `[open]`: "leave docker installed but don't enable it. Turn on if a specific project needs it". "yeah i think like let's nuke it we don't need the darker thing" (L723).
- **R-INFRA-5 — Caddy for auto-TLS via sslip.io at `https://95-217-119-40.sslip.io/`.** Continuation summary. Test: `/audio` endpoint returns 200 with TLS.
- **R-INFRA-6 — Node 22, Bun runtime, `zsh + oh-my-zsh + powerlevel10k + Tejas's .zshrc`.** IMPLEMENTATION Phase 0. "I used ZHSRC in my local here and we should use there too" (L1410). Test: `echo $SHELL` = zsh; Tejas's dotfiles present.
- **R-INFRA-7 — Automatic-updates for CLIs (built-in), NO weekly cron.** "Wait don't set up nonsense I don't want a weekly cron update set these tools already come with automatic updates" (L1409). Test: no update cron; tools self-update.
- **R-INFRA-8 — Slack tokens at `/root/.config/concierge/slack-*.toml` chmod 600.** DESIGN §13.

### 1.18 Data model (SQLite)

- **R-DB-1 — SQLite state at `~/.local/state/concierge/state.db` via bun:sqlite.** DESIGN §9 + continuation summary. Test: file exists, tables present.
- **R-DB-2 — Tables: channels, sessions, turns.** DESIGN §9. Test: `.schema` shows these tables with columns matching DESIGN spec.
- **R-DB-3 — Session UUID persisted on every capture (fixes Noos in-memory Map bug).** DESIGN §6 + IMPLEMENTATION Phase 6. Test: bot restart → thread resume still finds correct UUID.
- **R-DB-4 — `UNIQUE(session_id, slack_user_msg_ts)` for turn idempotency.** DESIGN §9. Test: same Slack event delivered twice → single turn row.

### 1.19 Naming / project identity

- **R-NAME-1 — Overall bot: Concierge (`@concierge`).** DESIGN §17. "concierge makes sense" (L1448).
- **R-NAME-2 — Codebase folder: `slack-concierge`.** "in the folder name should be slack concierge or something but in this Slack you can just use the concierges app name" (L1448). Test: repo at `~/workspace/slack-concierge/`.
- **R-NAME-3 — Slack workspace: `tejazz.slack.com`.** L1397. Test: bot installed there.
- **R-NAME-4 — TypeScript codebase (matches Noos + Bolt SDK).** DESIGN §17.

### 1.20 Autonomous end-to-end testing (parent-session goal)

- **R-TEST-1 — The whole loop of every requirement must be tested and iterated.** "Did you fking understand what the fk my requirement is? The whole fkin loop of every single requirement I've given you has to be tested and iterated and fixed. I'm not asking for the password to be fixed here" (continuation summary). Test: this doc + parent's autonomous test run cover every R-* item.
- **R-TEST-2 — Agent tests via Slack Web API directly using bot token / user token (no browser, no MCP needed).** "No browser! I asked you go look at thinkering and see how it does or i asked you to research how anthropic connects with slack so figure it out no browser no mcp" (continuation summary). "Don't need MCP" / "You don't need MCP". Test: all tests run via `curl slack.com/api/*` or slack SDK, no browser.

---

## 2. Explicitly REJECTED simplifications (do NOT backslide)

Codex reviewer produced simplifications in `tmp/reviews/codex-review-1.md` §OVER-ENGINEERING, §FEATURE-CREEP CANDIDATES, §SIMPLIFICATIONS. Tejas categorically rejected them at L1584:

> **Tejas (L1584):** "Codex has been an idiot here. No! I want fucking cloud to work as well I want fucking cloud to working as well do you understand that? Everything that we build should have proper abstractions and proper interfaces because ibus should be able to like plug in plug out put in throw out anything I want no dependencies should be so tightly wired that we're attached to it fork on day one. I need fork on the day one, understand this. Mother fucker! ... The whole purpose of Inbox is to do routing. What the fuck is your problem here? A pebble ring we can add in later slack list is hand canvas most important thing because I want to experience how it feels like image and artifact handling most important i'm not going to use this app if its a purely degenerated third tier, lower tier experience than my other apps."

Item-by-item:

| Codex proposed to KILL | Tejas response | Verdict |
|---|---|---|
| Full Noos fork → copy only useful modules | not directly addressed but design retains Noos fork (§6) with fixes | KEEP fork strategy per DESIGN |
| Codex app-server + WebSocket → use subprocess | User initially insisted "we don't have to use codexexec and they have a whole runtime that we wanted to use" (L1164); implementation later reverted to `codex exec --json` because app-server didn't work (continuation summary). PRAGMATIC compromise. | Whichever works, both providers must be pluggable and forkable |
| `AgentProvider` abstraction (delete `fork`, `additionalDirs`, `progress`, whole abstraction if only Codex) | REJECTED. "Everything that we build should have proper abstractions and proper interfaces... plug in plug out put in throw out anything" (L1584). "I need fork on the day one" (L1584). "there could be multiple CWDs all of those things" (L1584). | KEEP abstraction, KEEP fork, KEEP additionalDirs, KEEP progress |
| Multi-bot skill architecture (delete §8, `bot_user_id`, Phase 9 skills) | REJECTED. "I already have a substack editor skill that I use I want to be able to invoke that That's the whole point" (L1584). "yeah I think we need multi bot approach" (L801). | KEEP multi-bot, substack-editor is a required Day-1 skill |
| Standalone `concierge` CLI (delete Phase 2) | Deferred by Tejas: "I don't know why we would need a CLI here" (L1584). NOTE: this is one place Tejas partially agreed with Codex. | LIKELY DROPPED (in-bot handlers instead); confirm before removing entirely |
| Relational SQLite (turns/parent_session_id/parent_message_idx/additional_paths/bot_user_id) | NOT DIRECTLY REJECTED, but implied by other rejections: fork message-idx tracking needed (R-SHORT-1), additional_paths needed (R-CHAN-10), bot_user_id needed (R-BOT-1). | KEEP all columns |
| `/auth-refresh` and pty-based re-auth | REJECTED. "Why is auth refresh so difficult to build?" (L1584). Also L801: "yeah lets put the authentication as a thing as a slash command in the design here so we can do that for both claude and codex". | KEEP `/auth-refresh` for BOTH providers |
| Slack scopes: `files:*`, `slack_lists:*`, `file_shared`, `channels:manage` | REJECTED. "slack list is hand canvas most important thing" (L1584). "image and artifact handling most important" (L1584). Channel management needed for R-CHAN-9. | KEEP all scopes |
| Pebble Ring | Deferred to when device arrives (~1 week). L859. "A pebble ring we can add in later" (L1584). | DEFER (not kill) — see §3 |
| Slack Lists | REJECTED (Codex said "Kill, not defer"). "slack list is hand canvas most important thing" (L1584). | KEEP |
| Image/artifact handling | REJECTED. "image and artifact handling most important i'm not going to use this app if its a purely degenerated third tier" (L1584). | KEEP |
| Router agent in `#inbox` | REJECTED. "The whole purpose of Inbox is to do routing. What the fuck is your problem here?" (L1584). Deferred manual routing per DESIGN §14 is a compromise. | KEEP router as a real requirement; auto-classification design iterated |
| Grafana / dashboard | Not directly addressed. Deferrable. | DEFER |
| `/fork`, rollback, message-index fork | REJECTED. "I need fork on the day one, understand this" (L1584). L1283 also confirms `/fork` needed. | KEEP |
| `/add-dir`, `/remove-dir` | REJECTED implicitly by R-CHAN-10 requirement. "there could be multiple CWDs all of those things" (L1584). | KEEP |
| Per-channel modes `agent-auto | agent-tag | silent` | REJECTED. L801 confirms channel modes. REQUIREMENTS.md R13 promoted. | KEEP |
| Skip vault Obsidian sync entirely for MVP | REJECTED. "What do you mean by wall sink via obsidian headless? Are you saying we're not even going to do the obsidian sink? What the fuck is that?!" (L1584). | KEEP obsidian-headless sync |
| Skip Canvas ↔ AGENTS.md sync | REJECTED. "slack list is hand canvas most important thing" (L1584). | KEEP |

**Overriding principle:** "The whole point of us building this is make it superior and actually conform to my own workflows. If its low tier, if its garbage bullshit, I'm not going to use this. Do you wanna build something garbage and I am never gonna use or do you wanna built perfection here that I can actually use?" (L1584).

---

## 3. Deferred / "maybe later"

- **Pebble Ring webhook** — physical device arrives in ~1 week. Endpoint stub OK. (L859, L1584)
- **Router agent in `#inbox` auto-classification** — DESIGN §14: "Captures land in `vault/inbox.md`; user promotes manually via slash commands until we have signal". "let's just like do auto routing and then we need to figure out how to make sure auto routing works perfectly but again... let's design this iteratively I don't think we can design it right now" (L865). Ship manual-routing first.
- **Grafana / dashboard on AX41** — IMPLEMENTATION Phase 9. Not requested; nice-to-have.
- **Additional skill bots beyond substack-editor** — brief-summarizer etc. IMPLEMENTATION Phase 9.
- **Two inbox channels (`#capture` vs `#do`) or per-message "act on this ↑" reaction** — REQUIREMENTS.md `[open]` `#inbox` router. "Design later."
- **1x → 2x zram bump** — "later we can think about when would we know that we need 2X" (L540).
- **Migrate chess-with-friends from Mac to AX41** — mentioned mid-conversation as a candidate coding project to test with. Pending.
- **Slack Canvas rich text** — "clouded MD as just plain Markdown is fine for now I don't need rich text" (L716). Defer rich text.
- **Faster-whisper on AX41** — only if Monologue fails. Currently deferred.
- **Voice memos → AX41 rsync path** — "if that's the backup option especially what about my voice memos so will my voice memo stop working completely" (L966). Working today via iCloud + Mac; migrate to AX41 later.
- **Local LLM hosting for demos to friends** — "For some smaller projects where I would want some LLM included in my projects just host that on my machine for other people to use it especially because I can then use my coding agents and subscription plan" (L374). Future.
- **Auto-metrics** — IMPLEMENTATION Phase 9.

---

## 4. Open ambiguities

- **Run-as-root vs user?** IMPLEMENTATION uses `/root/workspace/vault` and `/root/.config/concierge`; DESIGN uses `~/workspace/vault`. Codex flagged (L~8023). Continuation summary confirms `/root/workspace/vault` in practice. Resolve: **is this permanent or does Tejas want a `concierge` user?**
- **`/fork atMessageIdx` on Claude Code:** Codex flagged. `claude --fork-session` support unclear. (Q at review §Questions L~8025.)
- **`project-note-for-<x>`: what is `<x>`?** Slack channel name? vault path? project slug? existing journalmaxx `#project/<slug>` tag? Codex flagged (L~8029).
- **Monologue cursor advancement is lossy.** DESIGN §4 says "Updates cursor to now" — data-loss footgun per Codex RED. Resolve before shipping.
- **`chat.update` above 4000 chars fails** — DESIGN §11 says edit placeholder. Must post as new msg when long. Codex RED L~7919.
- **Journalmaxx "verbatim" port** — scripts hardcode Mac paths + use `/usr/bin/lockf` (Mac-only). Codex RED L~7921. Not verbatim.
- **Monologue file naming vs `/ingest` expected names** — `monologue-<uuid>.md` not in `/ingest` known filename set (`freeform.md`, `log.md`, `todo.md`, `voice-*.md`, `dictation-*.md`, `reminders.md`). Codex RED L~7923.
- **Skills registry: inside vault or not?** L992: "Why is there a skills registry inside the vault? Why does it have to be in the vault we already have a dot agents folder in my laptop." Resolved to `~/workspace/skills/` OUTSIDE vault (R-VAULT-8) — verify design reflects.
- **Standalone `concierge` CLI: kill or keep?** Tejas said "I don't know why we would need a CLI here" (L1584) but IMPLEMENTATION Phase 2 still lists it. Resolve before implementing.
- **Session-transcript file at `sessions/<id>/TODOS.md` vs `<cwd>/TODOS.md` for `/todo`** — REQUIREMENTS.md `[open]` unresolved.
- **Which subset of Codex app-server methods needed?** Codex Q L~8027. Only start/resume/turn for MVP?
- **Older Obsidian vault (Readwise-heavy) merged into journalmaxx vault** — L1336 hoped for no duplicates. Verify content integrity.
- **1GB Obsidian Sync plan limit vs older vault size** — L1320. Verify current vault fits under 1GB or upgrade plan.
- **`obsidian-sync` bad filename (ENAMETOOLONG on Readwise `Abjk…md`)** — continuation summary. Unresolved.
- **`user_token` (xoxp-) still not added** — continuation summary. Blocks certain API-based tests.

---

## 5. Non-requirements (things he said NO to)

- **NO emoji reactions as primary UX.** "I'm not gonna be doing any emojis and all of that bullshit" (L1283). Emoji 📝 reaction todo capture proposed in REQUIREMENTS.md but subordinate to `/todo`.
- **NO iCloud-as-middleman for voice → AX41.** "this is complete garbage first of all the iCloud thing still relies on my laptop to be upright I don't want that unless I can mount my iCloud directly to my AX41 machine then I'm not gonna have my laptop being in the middle" (L801). REQUIREMENTS.md REJECTED explicitly.
- **NO laptop as always-on dependency.** Same L801. "my laptop is not the machine that's always on and running right it can't sleep it can be in my bag".
- **NO paid OpenAI Whisper API.** "Whisper is free! Why would you pay for something?" (L907).
- **NO Agent SDK for Claude Code (uses API billing, not subscription).** "I don't think we can use Agent SDK because that means Agent SDK also uses API billing so I don't think thats a solution" (L859).
- **NO high-availability / external ping / telegram alerts.** L609, REQUIREMENTS.md `[open]`. `systemctl Restart=always` is enough.
- **NO SSH from phone for auth refresh.** L723. Use `/auth-refresh` slash command instead.
- **NO Docker enabled by default on AX41.** L723 "let's nuke it we don't need the darker thing".
- **NO streaming to Slack.** L716 "we're not going to be streaming our responses here".
- **NO rich-text Slack Canvas.** L716 "clouded MD as just plain Markdown is fine for now I don't need rich text".
- **NO `#cloudcode` inline tag.** L966: "why do we have a hashtag cloud tag remove the tag if you're gonna have an ad add cloud code app installed why would he need another tag make it simple". Use `@claude-code` bot mention only.
- **NO `codex exec` if the runtime supports better.** L1164 (soft rejection, later pragmatically reversed).
- **NO weekly cron updates.** L1409.
- **NO watch-node vs laptop-node routing heuristics.** "We don't need routing heuristics what is the difference between watch node and laptop node? Are you fucking kidding me right now tell me one requirement that requires this" (L1112).
- **NO separate `journal.md` + `inbox.md`.** L1238: "again why do we have inbox.md and journal.mdd how many times should i say we should simplify". Use just `inbox.md`.
- **NO `vault/projects/personal/` split.** L1181: "Why did you come up with vault projects personal all of those nonsense I don't understand". (This was about SUBDIVIDING projects into `personal/`, `work/`, etc. sub-namespaces — that's still rejected. However, a FLAT `vault/projects/<channel>/` namespace for bot-created dirs was later approved 2026-08-07 to avoid polluting vault root — see R-CHAN-1.)
- **NO `/new-code` separate from `/new`.** L1891: "why are these slash commands for new code what is new code?". Single `/new` per R-SLASH-02.
- **NO forced `@concierge` mention to trigger agent.** L2012, R-CHAN-4.
- **NO auto-classifier reinvention.** L966: "why do you have a classifier? Do you even understand how... How general max is working?". Use existing `/ingest`.
- **NO nested-folder assumption via first-hyphen split.** L1238: rejected; use underscore for hierarchy.
- **NO storing coding projects inside Obsidian vault.** L966, L1181, R-VAULT-6.
- **NO Chrome-extension / MCP / browser automation to test Slack.** Continuation summary: "No browser! ... no browser no mcp" / "Don't need MCP".

---

## Cross-reference index

- Transcript file: `/Users/tejasdc/.claude/projects/-Users-tejasdc-workspace-ideaflow-cortex/1a9cbe29-2afb-4bd0-9269-7272cf5c9b9d.jsonl` (2437 lines).
- Design: `/Users/tejasdc/workspace/slack-concierge/DESIGN.md`.
- Implementation plan: `/Users/tejasdc/workspace/slack-concierge/IMPLEMENTATION.md`.
- Live requirements log: `/Users/tejasdc/workspace/slack-concierge/REQUIREMENTS.md`.
- Codex review: `/Users/tejasdc/workspace/slack-concierge/tmp/reviews/codex-review-1.md` (§7917-8043 contains the primary review body).

---

**Total confirmed requirements: 87** (across sections 1.1–1.20, R-CHAN-* through R-TEST-2).
**Total rejected simplifications reviewer-side: 17** (§2).
**Total deferred: 12** (§3).
**Open ambiguities: 15** (§4).
**Explicit non-requirements: 22** (§5).
