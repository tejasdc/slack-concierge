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

**Updating later, including from an agent on the Mac:** run
`launchctl kickstart gui/$(id -u)/com.tejasdc.concierge-update`. That separate one-shot
launchd job pulls `main` (refusing a dirty checkout or another branch), reinstalls and
restarts Concierge from outside its process tree, logging to `logs/update.log`. The restart begins within seconds and ends the triggering run, so an agent sends its reply first and triggers the update as its last action. Never
restart Concierge from a process it started: stopping the agent stops its whole process
tree, so on 2026-09-18 an installer started by a Mac session died at the stop and left
the agent down. `install-mac.sh` now hands off to the update job when it detects that
case, and refuses when the job is not installed yet. The first install after this change
must be run once from a terminal. This is the Mac's counterpart of remote-box's deployment
worker, but on demand: pushes do not update the Mac automatically.

The script pins bun 1.3.14 under the state directory, installs locked dependencies,
copies `router-actions.sh` to `~/.local/bin`, renders the plist with this Mac's tailnet
address and provider executables, and (re)starts the agent. Logs:
`~/Library/Application Support/concierge/logs/concierge.{log,err}`. Check:

```sh
launchctl print gui/$(id -u)/com.tejasdc.concierge | grep -E 'state|pid'
curl -s --unix-socket "$HOME/Library/Application Support/concierge/requests.sock" http://localhost/sessions/v1/status
curl -s -H "Authorization: Bearer $(cat "$HOME/Library/Application Support/concierge/peer.token")" http://100.90.183.122:8788/sessions/v1/peers
```

Projects are every `~/workspace/<dir>` with `.git` and `AGENTS.md`. There is no Inbox,
capture ingress or deployment pipeline on the Mac; `GET /sessions/v1/inbox` answers 503 there.

### Codex on the Mac

Codex runs the way remote-box runs it (`systemd/concierge-bot.service` `ExecStartPre`):
the managed standalone package `~/.codex/packages/standalone/current/codex` started with
`codex app-server daemon start` (backend `pid`, control socket
`~/.codex/app-server-control/app-server-control.sock`). The package comes from Codex's own
installer, `curl -fsSL https://chatgpt.com/codex/install.sh | sh`; the installer refuses to
start the daemon without it. `install-mac.sh` starts it and warns when
`codex app-server daemon version` does not report `running`.

The `~/.codex` sync job (`rsync-workspace-icloud`) must exclude `app-server-daemon/`,
`app-server-control/` and `packages/`: on 2026-09-18 the box's Linux package and pid/lock
files had been mirrored onto the Mac, which made `codex` unrunnable there and the daemon
believe it was already running. The excludes are in `sync-remote.yaml`; the mirrored
files were moved to `~/.codex/synced-linux-state.stale-20260918/`.

## Provider accounts on either instance

Thinkering's Provider accounts surface covers both machines. It shows one section per
instance — which account Claude Code and Codex are signed in as there, that account's usage,
and the named credential snapshots saved on that host — and starts a sign-in, finishes one
with a pasted code, saves an account or switches to a saved one, for whichever instance he
picks. He does all of it from his phone; neither machine's screen is involved.

The owner routes this by the `machine` field on its auth routes (see the wire contract). A
call for the peer is forwarded over the existing peer channel to the peer's identical route,
and the login process runs there, under the peer's own Concierge. That is the boundary:
each instance writes only its own credentials, and a credential change is still one
operation with its activation on the machine it happened on. Nothing here copies a
credential between machines.

A peer that is not answering is shown as not answering, with its reason, beside the machine
that is. The surface never hides a machine and never fails wholesale because one is down.

**Never diagnose the Mac's Claude sign-in over SSH.** macOS keeps Claude Code's credentials
in the login Keychain (service `Claude Code-credentials`), and that Keychain is readable only
inside Tejas's GUI session. At one moment on 2026-09-22 the same binary reported
`loggedIn: false` over SSH and the real account (`Claude Max`) under the launchd agent. SSH
will tell you the Mac is signed out when it is signed in. Ask the Mac's own Concierge —
`GET /sessions/v1/auth/providers?machine=mac` — which runs in that GUI session and sees the
truth. The same fact is why a sign-in started there can write the Keychain without anything
appearing on his screen.

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

### Speech-to-text on the Mac

A Mac on macOS 26 or later transcribes recordings with Apple's on-device SpeechTranscriber.
`install-mac.sh` compiles `bot/native/apple-speech-server.swift` into the state directory's
`speech/` with `swiftc` (Xcode Command Line Tools) when its source changes, and runs it once so
the locale's speech assets are installed before the first dictation (`CONCIERGE_SPEECH_LOCALE`,
default `en-US`). Browser recordings also need `ffmpeg` (`brew install ffmpeg`); the installer
warns when either is missing. Concierge starts the helper at boot and keeps it: it holds ~21 MB
while Apple's model lives in the system, and file transcription asks for no Speech permission.
On older macOS the Mac keeps recordings and says it cannot transcribe them.

Dictating in Thinkering in a browser on the Mac never goes through the box for its words. The
page sends each two-second piece to this Mac's Concierge on 127.0.0.1 as it is recorded, Apple's
engine transcribes it as it arrives, and stopping waits only for the last moments (about
0.1–0.2 s after stop, even for a four-minute recording, measured September 21, 2026).

- **Safari** uses `https://127.0.0.1:8791`. WebKit 26 blocks an https page's requests to plain
  http loopback, and no Safari setting changes that. `install-mac.sh` creates a certificate for
  127.0.0.1/localhost only (`speech/tls/` in the state directory, 800 days, renewed a month
  before expiry) and, at the end of the install, macOS asks once for his password to trust it.
  Declined, Safari keeps server transcription until the installer runs again.
- **Chrome** uses either address after he allows its one-time local-network prompt for thnkr.ing.
- The journal shows `live_speech_probe` (with the scheme and browser) when a page checks, and
  `live_audio_transcribed` with `after_stop_ms`. `CONCIERGE_SPEECH_LISTEN` moves the http port
  (loopback only; https is the next port) and `CONCIERGE_SPEECH_ORIGINS` lists the pages served.

When the page could not produce the words (refused, asleep, failed), the owner that holds the
recording transcribes it with its own engine: the box's Parakeet, or Apple's on a Mac-only
installation. Recordings are never relayed between machines to be transcribed.

## Permission prompts on the Mac

The general rules — identity is permission, ask as yourself, ask at the moment of need, never
request what the feature does not need — belong to the `macos-identity-and-permissions` skill,
which also holds the incidents that produced them. This section is the Concierge-specific
delta: what this host is, and what it has been granted. The catalogue's aliases have not
reconciled on this Mac since 2026-09-07, so until that is fixed read the skill directly from
`~/workspace/skills/macos-identity-and-permissions-skill/` rather than expecting it to load.

macOS names whatever program asks for a permission, so while launchd ran bun directly every
folder and Accessibility prompt said "bun" (Tejas, 2026-09-20). launchd now starts a small
signed app, `thnkr.ing.app` in the state directory's `app/`, whose only job is to start bun
and wait. Prompts name the app, and the service and every agent it starts count as it.
Tejas chose this on 2026-09-21 and grants the app Full Disk Access once.

- **Identity.** The app's bundle identifier `com.tejasdc.agent-host` and its signing key are
  its permanent identity. The key is a dedicated local signing identity created once in
  `signing/` in the state directory, and nothing else uses it. macOS keeps an approval as
  long as the identifier and that key match (Apple's designated-requirement rule), so the
  display name can change (`CONCIERGE_MAC_APP_NAME`) and the launcher can be rebuilt
  without another approval. Deleting `signing/` or changing the identifier means
  approving again.
- **Names he sees.** The bundle's display name and its executable are both the display name,
  and both launchd jobs carry `AssociatedBundleIdentifiers`, so background-activity notices,
  Login Items and Privacy settings show the app, never `agent-host` or `bash`. Neither the
  executable's file name nor the display name is part of the designated requirement.
- **Builds.** `scripts/build-mac-agent-host.sh` rebuilds only when the launcher source, its
  metadata or the name changes, before launchd is touched, so a failed build leaves the
  running agent alone. Updates to the service's own code never rebuild it.
- **Not covered.** The Codex app-server runs as its own daemon, so work inside Codex sessions
  still shows as "codex". The update job runs as bash; it only uses Git and the installer.
- **Accessibility.** Nothing needs it. Mac agents are told not to script other apps unless
  he asks for app control.

### Screenshots

Agents can photograph a window or a screen on the Mac. Tejas asked for this on 2026-09-22
("if the agents want to take a screenshot of the app or something on the MacBook, it should
be able to"), after an agent tried it, macOS asked, and nobody had explained what was being
asked for.

```sh
~/.local/bin/mac-screenshot status            # what macOS permits; never prompts
~/.local/bin/mac-screenshot windows [name]    # id, app, title, size of every on-screen window
~/.local/bin/mac-screenshot app Safari        # that app's largest window, and nothing else
~/.local/bin/mac-screenshot window 173        # exactly that window
~/.local/bin/mac-screenshot display           # a whole screen, only when asked for explicitly
```

Provider children do not have `~/.local/bin` on PATH, so agents call it by that absolute path.
`bot/native/mac-capture.swift`, built by `install-mac.sh` into the state directory's `capture/`.

- **What he granted.** One permission, "Screen & System Audio Recording", held by the
  agent-host app — so every agent session on this Mac can capture his screen while it is on.
  There is no narrower macOS permission: `SCContentSharingPicker` avoids the grant only by
  making a person choose the content each time, which no unattended agent can do. Narrowness
  therefore comes from what is captured, which is why the tool wants a window and treats a
  whole display as the explicit exception. For a page in Thinkering or any other web app,
  prefer the browser's own screenshot (agent-browser, Playwright): it needs nothing from him.
  He turns it off in System Settings > Privacy & Security > Screen & System Audio Recording;
  nothing here needs that switch except capture.
- **Asked at the moment of need.** Nothing requests it at startup. The helper preflights with
  `CGPreflightScreenCaptureAccess`, and only a capture that is actually wanted calls
  `CGRequestScreenCaptureAccess`, which is what shows the alert and puts the app in the
  Privacy list. There is no Info.plist purpose string and no entitlement for screen capture —
  the alert's wording is the system's — so the helper prints the sentences to relay to him
  instead, and names System Settings only for the one case where he has refused before and
  macOS will not ask again.
- **Why it sticks.** macOS decides by the *responsible* process, which is the signed app at the
  top of every agent's process tree, so the approval is recorded against
  `com.tejasdc.agent-host` and survives rebuilds of the launcher exactly as Full Disk Access
  does. Measured on 2026-09-23: he approved it at 02:36Z, 1½ hours after the agent host
  started, and a capture run at 02:55Z through five levels of child processes was permitted
  with no restart of anything. macOS 15 and later still show an occasional reminder (Apple
  settled on about monthly) for any app that captures the screen; that is Apple's nudge, not
  a lost approval, and the only exemption is the managed VNC `persistent-content-capture`
  entitlement, which Apple grants by application and a locally signed app cannot have.
- **Never `screencapture`.** Without the permission the system tool still writes a file
  containing the desktop picture and the menu bar with every window missing, so a caller
  cannot tell a refusal from a photograph of the wallpaper. ScreenCaptureKit reports the
  refusal, and `SCContentFilter(desktopIndependentWindow:)` captures one window's pixels and
  nothing else that happens to be on screen.
- **A capture is a picture of whatever is open.** `windows` also reveals every window title.
  Treat both as his private material: keep them out of logs and public artifacts, and put a
  file where the work needs it rather than leaving copies in `/tmp`.

## Out-of-band access to the Mac

Tejas approved on 2026-09-18 (Inbox, 21:47Z): remote-box agents may reach the Mac over SSH
so they can repair or update it when its Concierge is down, until the cross-machine work
settles. It uses the Mac's built-in Remote Login and one dedicated key:

- Key: `/root/.ssh/mac_ed25519` on remote-box, used only for this.
- On the Mac, `~/.ssh/authorized_keys` holds its public half prefixed with
  `from="100.118.245.110"`, so the key works only from remote-box's tailnet address.
- Use: `ssh -i /root/.ssh/mac_ed25519 -o IdentitiesOnly=yes tejasdc@100.90.183.122`.
  A non-login SSH shell lacks the user PATH: run `zsh -lc "…"` or call `~/.local/bin/claude` directly.
  For an update prefer the update job (`launchctl kickstart gui/$(id -u)/com.tejasdc.concierge-update`).
- The key grants the same access Tejas has on the laptop. It is still bound by the
  distribution rules: code changes travel through Git, never SSH edits.
- To turn it off: delete the line ending `remote-box agents -> mac` from
  `~/.ssh/authorized_keys` on the Mac (or switch off System Settings > General > Sharing >
  Remote Login, which also stops his own SSH).

## Protocol parity: what survives every hop

A request, reply, return, attention item or delivery record looks and behaves the same
whichever instance either side runs on. Tejas asked for this on 2026-09-18 after Mac
requests arrived without their sender or originating request, as raw delivery text:
"the communication protocol needs to be ... brought parity with what we had".

**Fields that must survive every hop**, and where each is resolved. These are shared
code paths, so a hop between instances goes through the same function as a local one:

| Field | Carried as | Resolved by |
| --- | --- | --- |
| Sending session | delivery `origin.sessionId` / reply `responder.sessionId` | `sessionAuthor` (`session-message-author.ts`): local ledger, else this instance's catalogue of the peer |
| Originating human request | delivery `origin.originatingHuman` | `sessionInputProvenance` → `peerDeliveryProvenance` (`session-inputs.ts`) |
| Effect scope | delivery `origin.effectScope` + `requestedEffect` | same; narrows to informational on any informational hop |
| Request ID | the shared UUID on both ledgers | `session_peer_requests` (origin) / `session_peer_deliveries` (target) |
| The sender's words | delivery `message` (the `text` field adds the provider preamble) | `acceptedInputAuthor`: message text, never the preamble or envelope |
| Reply / return / overdue kind | `session_peer_events.kind` + payload | `peerEventAuthor`: `communication` reply, result or overdue |

**Identity rule** (`bot/src/peer-identity.ts`): each instance names its own sessions
`concierge:<n>` and another's `<peer>:<n>`. The receiver names every arriving identity
with `receiveSessionFromPeer`: a plain `concierge:<n>` is the sender's own session and
becomes `<sender>:<n>`; `<receiver>:<n>` becomes `concierge:<n>`; anything else is kept.
The sender's own session fields (`origin.sessionId`, `responder.sessionId`) travel plain,
which keeps older peers working. The originating human request can name a third
instance, so the sender presents it as `<self>:<n>` (`presentSessionForPeer`).
Thinkering's federation applies the same rule towards the app. Read-time normalization
repairs rows retained before senders presented identities, so no migration is needed.

A new field that must cross machines goes into the delivery or reply body and is resolved
by one of the functions above, never by a second, peer-only projection.

## When a peer is down

- Search never goes empty: the transcript archive on remote-box
  (`/root/transcript-archive/mac-claude-projects`, `mac-codex-sessions`, pushed from the
  Mac every 5 minutes by `com.tejasdc.sync-remote`) is the primary index. An archived
  transcript that belongs to a Mac Concierge session (matched by its Claude/Codex session
  UUID against the last catalogue the Mac answered with, `session_peer_catalogue`) is shown
  as that session with `availability:{reachable:false,note}`; other Mac transcripts (paths
  under the peer's configured `paths`) are shown as archived evidence from the Mac.
- Resurrection: an `archived-only` Mac session can continue on remote-box as a distinct
  session — Thinkering's "Resurrect on Cloud" button or `sessions ask <mac/session:…>
  --resurrect`. The archived transcript (`archives` in `CONCIERGE_PEERS`) is copied into
  the provider's store here (`~/.claude/projects/<cwd-slug>/<uuid>.jsonl` or
  `~/.codex/sessions/YYYY/MM/DD/`) and the session binds the provider's native resume by
  that UUID; the project is the same folder name on this machine. The Mac's original
  session stays parked and is never merged.
- Mac asleep or offline: `sessions ask` to a Mac address or `--peer mac` is accepted with
  status `queued_offline`; the exact delivery body is retained and handed over when the Mac
  answers again (every minute while something is owed), then the request proceeds as usual
  and the requester sees a progress note. `sessions context` answers from the archived
  transcript. Requests already delivered keep their rows on both sides; the target retries
  its notifications and replies, and the origin's 30-minute inspection reports the queue.
- remote-box down: the Mac keeps running its own sessions; replies to cloud requests stay
  `pending` and forward when the box answers.
- Neither side ever replays a provider effect for the other.
