# Concierge agent guide

Concierge is the shared session and request owner behind Thinkering. It is a personal,
single-operator application. Thinkering is the product surface and Tejas's real use is the
acceptance feedback.

The coordinated responsiveness release follows the dependency checkpoints in
[Deployment](docs/runbooks/DEPLOYMENT.md#coordinated-responsiveness-release-dependency-order):
remote-box, server Concierge, Thinkering, then the Mac, with installed-revision evidence.

Codex's App Server starts only under its native disabled-updater preference on both
machines; installation and activation are separate, and a running listener is never
restarted merely to apply the setting. See [Codex App Server Lifecycle](docs/runbooks/CODEX-APP-SERVER.md).

## Current delivery policy

Tejas deprecated Slack in inputs `1789490232.840229` and `1789490293.092859` on
September 15, 2026. This supersedes the former Slack sandbox, feature-parity, full-gate
and mandatory review requirements in this repository and linked historical material.

- Do not build Slack features, preserve Slack feature parity, run Slack-specific tests,
  claim Slack sandbox lanes, or perform Slack click testing.
- Implement requested Thinkering behavior promptly. Before calling work done, check it end to
  end on the real system and say what you saw: his surfaces through your own marked entrance
  (`router-actions.sh test-capture`, or the socket and routes the feature itself uses), after the
  change is installed. A completed work reply is refused without `--checked` or `--not-checked`.
  Do not write unit tests to satisfy that, and do not run the old test suites or sandboxes; the
  Sept 15 no-agent-tests instruction (1789490492.818709) is narrowed to exactly that
  [decision: agents-check-real-end-to-end-behavior].
  Autonomous deployment repair runs no checks of its own. Model children do not inherit writable
  production state-directory configuration, and the ledger refuses test processes
  before opening SQLite. Do not bypass either boundary with alternate test config.
  The external repair supervisor launches no reviewers and requires an explicit
  committed-or-blocked result. Its incident budget survives resumes and revisions;
  terminal operator escalation is retained outside the application in the incident
  artifact and journal. See [deployment repair](docs/architecture/DEPLOYMENT-REPAIR.md).
- Fix observed failures within the requested scope and ship through the existing Git and
  deployment paths. Do not turn a bounded feature into hours of speculative analysis,
  repeated verification, or new process.
- Existing Slack runtime code and historical evidence are retained while the surface is
  deprecated. Their documentation is reference material, not authorization for more Slack
  work. Do not delete accepted work, conversation history or production state as cleanup.
- Tejas's input `1789508446.918989` replaces the temporary DM report destination with
  one native Thinkering Inbox for Pebble, Monologue and bug reports. Gesture metadata
  is provenance, not destination selection. Keep prior accepted destinations and
  uncertain effects immutable. Human correction `1789510460.238219` sends the retained
  reports through normal Inbox intake with provider invocation, preserving prior
  assignment metadata; use import-only only when explicitly requested. The [capture contract](docs/runbooks/THINKERING-CAPTURE.md)
  and [native Inbox contract](docs/contracts/native-inbox.md) own this boundary.
- Input `1789496623.399079` requires discovery and addressed communication for top-level
  Thinkering sessions from both native and existing Slack callers. Both use the common
  session owner; provider subagents are outside scope. That input authorizes completing
  the real blocked Releases/update-banner coordination as end-to-end evidence, without
  automated tests, sandbox runs or review cycles.

## Working boundaries

- Grafana health alerts queue the standing repair agent without a human Inbox thread; the external work-flow supervisor owns
  host resource pressure plus responsive-owner/speech memory and latency repair. Webhook acceptance alone does not
  prove notice delivery or agent admission. See [Grafana alerts](docs/runbooks/GRAFANA-ALERTS.md).

- Scheduled and banked work use the existing queued turn and wake timer. A saved item starts
  in its own named session, so later inputs follow its FIFO. `saved_kind` and the saved rule
  survive provider requeues. A banked item waiting for its chosen time has no provider-retry
  mark, including after a safe pre-admission refusal; clearing usage or switching accounts
  cannot release it early. Its current kind has one durable home; converting banked work to a
  schedule changes that kind.
  `sessions schedule --at` (optionally `--expires` and `--every-ms`) and `sessions bank`
  create saved agent requests, and Thinkering
  creation may supply `savedWork`. The router requires a registered project; Thinkering's
  creation path currently does not enforce that requirement. Both require an available provider.
  `sessions saved list|start|cancel` uses an exact source and stable action identity for changes;
  the owner lists waiting items at `/saved-work` and controls them at
  `/saved-work/<turn-id>/<start|time|schedule|drop>`. `time` changes only a schedule;
  `schedule` explicitly converts a banked item.
  Banked Claude work is released
  against fresh usage on any account this machine can launch; banked Codex work uses only
  the account currently signed in to the shared Codex App Server. Both release only while
  the selected account's most-spent allowance window remains below the reserve. A live Claude refusal makes
  that account ineligible even when its reported percentages look available. At most one
  automatic banked run may be active across sessions. The account
  choice is bound to the saved window: if that account has no room at dispatch, the turn
  waits rather than spending another account's allowance. Every new Codex turn runs on the
  shared App Server; Codex account homes remain the live credentials for usage readings and
  Accounts switching, never turn execution.
  Claim checks for ordinary queued or running work again. The saved work settings, including
  the quiet-hours time zone, belong to the owner at `/saved-work/settings`. When no safe window
  is known, a banked item has no advertised start time and no three-minute wake. The usage watch
  recalculates banked instants and records overdue attention once; the queue also settles
  scheduled work at its optional expiry. The queue remains the
  only timer that admits work. Repeating schedules create one future firing under a stable
  root and sequence; an overlap skips and records that firing. The latest firing places the
  next one once it is due or has left the queue by any path (each firing keeps its own
  instant in `saved_fire_at_ms`); only drop, archive or suspend ends a schedule. Both runtime compositions claim through `claimQueuedTurnWithSavedWork`, which runs these clock steps first; the Slack-enabled one used to claim without them, so every repeating schedule stopped after one firing (2026-10-07). A banked run stops at an allowance or deployment boundary.
  If the provider already admitted it, the cancelled turn is retained without replaying
  its input and raises one question for Tejas to inspect what completed. There is no automatic
  reconciliation, continuation or shipped-work checkpoint yet.
  Idleness uses this machine's work only; a busy peer is not visible to this gate. Allowance
  boundary stops follow existing usage readings, not an independent timer. A claim declined
  before provider admission still increments the queue's claim counter. Repeating schedules
  use fixed intervals rather than calendar dates. See
  [saved work design](docs/plans/2026-09-23-saved-work-scheduled-and-banked.md).
- Waiting and retrying follow [the waiting protocol](docs/plans/2026-09-24-waiting-and-retrying.md) and [Tejas's retry spec](docs/plans/2026-09-24-retry-spec-tejas.md): each named policy has attempt and age limits with jitter, and exhaustion produces one provider-free notice for the repair agent (see the repair agent bullet below), except for a dependency whose absence is normal: a peer machine that sleeps is never a notice (`announce:false`); work waiting on it reports to the agent that sent it, which decides whether Tejas needs to know, and peer work that ended without a final reply closes as stalled (Tejas, 2026-09-27 [decision: sleeping-peer-is-not-a-notice]; see [peer instances](docs/runbooks/PEER-INSTANCES.md)). Sign-in, usage, and chosen-time holds each release only on their matching condition. A chosen-time continuation must not be released by an account change. Claude background jobs are named in the deployment drain and receive 15- and 60-minute prompts in their owning run (`STILL_WAITING_AFTER_MS` [decision: still-waiting-after-15-minutes], the same 15 minutes after which an unanswered request is reported to its sender, except while a Concierge update is draining); an abandoned job may be ended with a boundary continuation after the quiet period. Finished background work reports back on its own, nested helpers included, so agents are told not to build waiters; the shell-text refusal of wait-only jobs was removed on 2026-10-07 after it refused real jobs (a guess from command text is not an enforcement boundary; see [the agreed design](docs/plans/2026-10-07-agent-work-and-updates-without-waiting.md)). When Claude marks a job ended (`task_updated`, or the job leaving `background_tasks_changed`) and its report has not reached the agent two minutes later, Concierge steers a notice into the run and stops holding the job (`noticeMissingBackgroundReport`), so an agent never waits forever on a lost notification. Use exact process IDs through `router-actions.sh wait --pid` rather than a pattern-matching wait loop. **While an update waits on an agent, that agent hears about it** (`update-wait-notices.ts`): after 15 minutes each run it waits for gets a steered service notice (again at an hour); on the Mac the wait is the marker `update-mac.sh` keeps while it finds work running. Tejas is not sent a separate notice: thnkr.ing's update line already shows the wait (he removed the duplicate Inbox notice on 2026-10-08). It never holds, ends or bounds anything.

Original Thinkering report `5eaa0768-0321-49cc-a3e0-25159b40ba6e` (retained capture
`27a881e393f0057c878be09c340b4f43e7bd8bbcfbbf667fd474fa3053dfece2`) explicitly
authorizes comprehensive native communication review and live multi-agent testing,
with Astra xhigh and no model experiments. That scoped work may opt in with
`CONCIERGE_TEST_AUTHORIZATION=native-attribution-5eaa0768`. Test preload and the
canonical-path production-state guard remain mandatory; this is not Slack testing
authorization or a change to the default rapid-iteration policy.

- One catalogue and accepting owner: canonical sessions, inputs, operations and correlated
  requests live in Concierge's existing ledger. Thinkering is an authenticated consumer
  and capability host, not another queue, dispatcher or session authority.
  Peer discovery uses durable prepared-card pages and deltas, never a full-view refresh;
  see [bounded offline catalogue](docs/runbooks/PEER-INSTANCES.md#bounded-offline-catalogue).
  Application workers are candidate-declared and checked before activation even by the
  preceding builder; see [release compatibility](docs/architecture/DEPLOYMENT-REPAIR.md#application-workers-and-the-first-upgraded-builder).
- Claude history pages use an off-owner SDK import and an indexed derived snapshot, then merge
  owner-retained live messages by exact identity. Cold history states that it is indexing;
  raw transcript changes without corresponding retained events trigger a background rebuild.
  See [provider history index](docs/architecture/PROVIDER-HISTORY-INDEX.md).
  Provider history page projection runs in a separate worker from the accepting owner loop.
  That worker resolves the Codex bridge from its sealed application artifact, not beside the
  worker bundle; the sealed-bridge check is in [deployment repair](docs/architecture/DEPLOYMENT-REPAIR.md#application-workers-and-the-first-upgraded-builder).
  Long history messages are page previews with an exact, digest-checked one-read selected-message
  detail; source, message and accepted-input identity remain attached to the preview.
  See the [history wire contract](docs/contracts/session-owner-v1.md).
- The interactive session catalogue is a prepared, bounded read over the owner's ledger;
  new card fields need canonical change-journal coverage and a growth fixture. The worker,
  cursor and exact-detail boundary are in [prepared session catalogue](docs/architecture/PREPARED-SESSION-CATALOGUE.md).
  The accepting request API owns the prepared worker lifetime in both native and adapter
  compositions; closing that API also stops its worker.
  Prepared routes require a registered read contract and executable growth fixture; the build
  and deployment seal refuse missing coverage. Unknown owner GET routes also refuse by default;
  named control and legacy exceptions live in the [read boundary](docs/architecture/STORAGE-OBSERVATION.md).
  Loop-lag records also attribute synchronous background storage and transaction finish time;
  request timings alone omit time before dispatch. The same storage document owns the diagnostic boundary.
  Offline investigations use the [bounded diagnostic snapshot entrance](docs/runbooks/DIAGNOSTIC-SQLITE-SNAPSHOT.md);
  an incremental copy of a changing live database can restart indefinitely and compete with serving traffic.
  The same catalogue document owns the release gates.
  That gate also exercises actual topic creation, mutation and worker restart through a
  prepared checkpoint with nonempty history; static reader fixtures alone are insufficient.
- Prepared receipt lists use one shared status policy for the owner and the presentation
  worker; live retry observations expire with the owner incarnation. See
  [prepared receipts](docs/architecture/PREPARED-RECEIPTS.md).
- Project folders are machine-local. `projects new` creates the canonical scaffold and a
  private `tejasdc` repository before retaining a peer setup order; `projects share` requests
  one existing pushed project on a named peer. The peer checks its own destination and never
  replaces a folder. A project list on one machine does not imply that folder exists on the
  other. See [peer instances](docs/runbooks/PEER-INSTANCES.md#durable-project-setup).
- Capture ingress owns only its capture database. Its executable may import the storage-neutral
  retry and database-retry primitives, but never the application notice worker, retry adapter or
  Concierge ledger; the service user is deliberately not given that production state path.
  It also keeps exact authenticated human commands until the canonical owner answers; a server
  custody receipt is never an owner receipt. Notification replies use the same intake, freeze their
  resolved owner target, and publish one Inbox notice if later refused. See [human command intake](docs/architecture/HUMAN-COMMAND-INTAKE.md).
- An outside CLI agent uses `router-actions.sh external` for Inbox capture or an addressed request;
  its named authorship and pollable reply live in the owner ledger, with no invented requester session.
  Outside capture retries keep one stable ID, and outside requests use the ordinary reminder and stall limits.
  The [router helper](docs/runbooks/ROUTER-ACTIONS.md) and [wire contract](docs/contracts/session-owner-v1.md) own this entrance.
- Retained audio attachments keep their original bytes and an optional transcript
  in the same attachment row. The authenticated human surface can request transcription
  of a retained audio ID before sending; retry reuses the retained text. Provider dispatch
  uses that text and avoids repeating it when it is already in the accepted human message.
  A forwarded recording is a new custody copy of identical bytes, so it reuses the words its
  original already has (found by `sha256`) instead of being transcribed again.
- Speech-to-text is one engine process per host behind one line protocol
  (`bot/src/speech-engine.ts`), chosen by platform. The Mac browser's listener and Apple engine
  run in their own launchd job and survive an unrelated Concierge update; see
  [Mac speech operations](docs/runbooks/PEER-INSTANCES.md#speech-to-text-on-the-mac).
  The box's Parakeet (~1 GB) loads on the first dictation and is released
  after ten idle minutes, because the iPhone and Mac now transcribe on the device and the box is
  a fallback. The box runs Parakeet TDT 0.6B v3 (`bot/native/parakeet-server.cpp`);
  audio over 45 seconds goes in pieces cut at pauses, because Parakeet's whole-file path
  dropped words on a long, mostly-silent recording (measured recordings that were mostly
  speech kept ~99%). A Mac on macOS 26+ runs Apple's on-device SpeechTranscriber
  (`bot/native/apple-speech-server.swift`, built by `scripts/install-mac.sh`), Tejas's choice
  of September 20, 2026, with no Parakeet-versus-Apple experiment. File transcription needs no
  Speech permission. Thinkering in a browser on that Mac transcribes while he talks through
  `bot/src/live-speech.ts`: loopback-only listeners on `127.0.0.1` (http 8790 for Chrome; https
  8791 for Safari, which blocks http loopback from an https page as mixed content), answering
  only the `CONCIERGE_SPEECH_ORIGINS` page (default `https://thnkr.ing`). They offer the iPhone
  app's speech contract (begin/append/finish/cancel/transcribe), decode each piece with a
  streaming ffmpeg and feed Apple's engine live, outside the one-at-a-time lane; the page keeps
  custody on the server and files the words as a device transcript. The https certificate names
  only 127.0.0.1/localhost, is created by `install-mac.sh` and trusted after one macOS password
  prompt; Chrome also asks once for its local-network permission. When the device produced no
  words, the owner that holds the recording transcribes it with its own engine: Parakeet on the
  box, Apple's on a Mac-only installation. There is no relay between machines (Tejas,
  September 21, 2026: the fallback is the owner path). On Linux the fallback runs in one
  independent supervised speech worker, with the owner alone committing its result;
  [speech fallback jobs](docs/architecture/SPEECH-FALLBACK-JOBS.md) owns the protocol,
  recovery and live checks. `audio_transcribed` names the engine (and the peer) and never text.
  whisper.cpp remains only as a logged fallback on the box and is scheduled for removal.
  `bot/scripts/install-transcriber.sh` pins the box's model by revision and SHA-256. Measurements
  and the wider voice design are in Thinkering's
  `docs/plans/2026-09-20-native-voice-capture-transcription.md`.
- An agent on the Mac may photograph a window or a screen, which Tejas asked for on
  September 22, 2026. One command, `~/.local/bin/mac-screenshot` (absolute path: provider
  children have no `~/.local/bin` on PATH), built from `bot/native/mac-capture.swift`. It uses
  ScreenCaptureKit, because `screencapture` without the permission writes the wallpaper and
  the menu bar instead of saying no. The permission is the agent-host app's, asked for at the
  first capture that is actually wanted and never at startup, so every agent session here
  captures as that app; a page in a browser is screenshotted by the browser instead, which
  asks him for nothing. Prefer one window to a whole display, and treat a capture and a window
  title as his private material. See [peer instances](docs/runbooks/PEER-INSTANCES.md#screenshots).
- Claude sign-in renewal uses the addressed Mac Codex browser worker and the existing
  Thinkering Accounts flow. Chrome computer use proved approval, code transfer and
  switching between both saved accounts; the Apple Events helper remains unproven.
  See [Claude sign-in approval](docs/runbooks/CLAUDE-SIGNIN-APPROVAL.md).
- Executable input receipts expose `statusDetail` with a human reason, known condition
  clearance time and whether that exact input retries automatically. Terminal failures
  remain immutable history. A native turn parked with an unconfirmed outcome is never
  replayed and never holds back later inputs: the next one runs and carries it as
  unconfirmed context, because nothing reconciles it and a Mac request sat queued behind
  one for five days (mac:69, Oct 1–6, 2026). A queued request that is held (sign-in, usage,
  or anything that will not clear by itself) tells its sender at once, from a peer too
  (`inputHold`). See the shared wire contract.
- A busy recipient is never a refusal. Agent requests and service returns use a
  coordinator-chosen live delivery; when the provider proves it never received that
  input, it returns once to the recipient's own queue and runs when that session next
  accepts work, keeping its input, request and event identity. Refusal is reserved for a
  session that genuinely cannot receive input, and for the deliberate human pinned
  `delivery:"steer"`. An acknowledged or ambiguous send is never re-enqueued.
- A follow-up to a running Claude session joins Claude Code's own streaming-input queue
  as a uuid-stamped message; it never interrupts the agent and has no per-message
  deadline while the turn is live. Stop is the only interrupt. Tejas approved this on
  September 18, 2026 ("we should start using Claude's own queue"). Every Claude message,
  opening or follow-up, is acknowledged when Claude's own transcript records picking it
  up (`claude-transcript-watch.ts`); the stdout echo arrives only with Claude's first
  output and is the fallback. So a waiting follow-up reads as queued until Claude takes
  it, and nothing after — shown from Claude's record, never estimated. The message itself
  is published at that pickup, from the same transcript row and through the same mapping
  as the later echo, so it appears when Claude takes it rather than with Claude's first
  reply, and the echo merges into it under the same identity. History lists that same
  message where Claude read it: a message that arrives while a tool is running is written
  by Claude Code as a `queued_command` attachment row, never a `user` row, and the SDK's
  history reader drops attachment rows, so `claude-queued-messages.ts` scans the transcript
  itself (append-only, once per new byte) and places each such message after the row it
  followed, under the uuid it was submitted as, which is the id the live echo carried.
  Two requests Claude had answered at 12:37 sat below each new message he typed with "read
  after 12:50 PM" because the page never listed them (Tejas, 2026-09-28, reported twice).
  Do not build a
  warm Claude process for speed: process start and `--resume` cost 1–2 seconds; the long
  wait before a reply is Claude working, which a warm process would also pay. See the
  [parity approach](docs/plans/2026-09-17-claude-session-parity.md).
- `statusDetail` explains only holds a person must know about or act on. Ordinary
  progress — waiting behind other work, awaiting dispatch, or queued in a live run —
  carries none; the input's state already says it is queued.
- Ambiguous steering follows its linked turn's confirmed terminal state, with a separate
  `STEERING_DELIVERY_UNCONFIRMED` explanation while provider acknowledgement is absent.
  Turn completion never proves that particular steering input reached the provider;
  keep `acknowledgedAt` null and do not replay it. See the shared wire contract.
- Saved sessions, saved messages and message reactions are personal owner state in that
  same ledger. Every message mark keys the canonical session plus exact provider message
  ID; Thinkering may cache projections but must not use browser storage as cross-device
  truth or reopen a neighboring message when an exact target is unavailable.
- Session search matches meaning as well as words (`bot/src/meaning-index.ts`, Tejas 2026-10-07 [decision: session-search-by-meaning]:
  "our search doesn't do semantic search"). EmbeddingGemma-300M runs on the box's CPU in a
  llama.cpp child process installed and pinned by `bot/scripts/install-meaning-engine.sh` on deploy;
  it is stopped when Concierge exits and killed by the kernel if Concierge is killed (`setpriv --pdeathsig`).
  Every passage is credited to the session that wrote it and keyed by author plus exact words: a
  request counts toward the session that received it, a reply and its returned copy (including a
  Mac session's reply that exists here only as a return) are one passage of the replier. Titles of
  this machine's and the peer catalogue's sessions and the archive's prompts (read from Thinkering's
  index, never transcript files) are included; tool output is not. Vectors live in `meaning-index.db`
  beside the ledger, never in it. Results fuse word and meaning ranks and say which matched.
  **One search for every machine:** a machine without the index (the Mac) sends `sessions search` to
  the machine that has it (`searchThrough`, owner route `search` with `everywhere`), which runs the
  same federated search the Inbox gets, including a live word search of the asking machine; the Mac
  searches alone only when the server cannot be reached, and says so. Decision history, starting
  with the September QMD evaluation, and the working-text measurement are in
  [session search by meaning](docs/plans/2026-10-07-session-search-by-meaning.md). Archive search joins indexed identity to exact prepared event proof; its consumer check runs in the build.
- Native discovery remains available when historical Slack routing evidence is unavailable.
  Report that source failure in search coverage and omissions; do not let a retired
  channel binding hide canonical sessions or claim complete historical coverage. Missing
  historical channel metadata omits that candidate with explicit coverage, preserving
  other candidates without recreating a channel or authorizing resume.
- Session names use the canonical metadata `title` shown in Thinkering. Router
  `--session-name` initializes that field; do not add a separate display label or
  infer names inside Concierge from task prose. See the shared wire contract.
- Thinkering-created Codex sessions retain the owner's selected default model and
  effort at creation. An admitted agent may name only its own session
  through `sessions title` with its exact source input/run and stable action ID; it
  may also correct that name later, because a session stuck with a bad name had no
  way to fix what he was reading (September 22, 2026). A title Tejas set himself
  through the app's Rename control always wins and is never overwritten. That is how a session
  Tejas starts by hand gets its name, so the session instructions name the helper by
  absolute path: provider children do not have `~/.local/bin` on PATH. A run that
  starts while its session is unnamed also gets one direct, prefilled title step; the
  general paragraph alone was skipped on a short request in the live check (Sept 19).
- Native session/input identity is independent of Slack. Never fabricate a Slack message,
  channel, timestamp or provider binding to satisfy an obsolete caller shape.
- Selected-message actions resolve exact retained native message references in the common
  owner. Comparison replays only human requests through that boundary; Inbox capture
  retains explicit note/action intent without a provider turn; task creation appends to
  the registered project's existing `notes/TODOS.md` authority. The browser never supplies
  replacement message bytes, and no parallel task store or Slack route is introduced.
- Retained DM and native agents route through `router-actions.sh sessions`: continue
  the live or recently completed session that built the surface in question when
  title, project, source, dialogue and send capability establish one exact owner.
  Mere topical similarity and consultation-only evidence do not authorize a resume;
  clarify ambiguous ownership. Create a named `cc-opus` session in the registered
  project when no session owns the work or the surface differs.
  Preserve an explicit human session/provider/model/effort choice, and discover an
  existing owner's exact address before asking it. The owner pins model,
  effort and cwd before dispatch. Preserve complete diagnostics/images in
  attachment custody. Do not alter already-running work because of this default.
  The native Inbox router itself is a Claude Opus 1M session in the `slack-inbox`
  repository; its extended context is for intake, not a destination worker
  setting. Discover project folders through `sessions projects`; choose
  `slack-concierge` for Concierge code and `thinkering` for Thinkering code.
  `D0BMWUJ3RD5` is a retired DM workspace, never a substitute project.
  See [router helper](docs/runbooks/ROUTER-ACTIONS.md); no channel restoration or post.
- What reaches Tejas and where work runs are enforced by the owner, not asked of agents
  (`session-roles.ts`, `answers-to-tejas.ts`, from the 2026-09-29 retrospective in
  `docs/retrospectives/2026-09-29-avoidable-failures/`). A session in a writing project
  (`WRITING_PROJECTS`, today `messaging-agent`) cannot send work requests: it reports a missing
  ability and the Inbox routes the building [decision: writing-agents-do-not-build]. A new
  session on a peer needs `--machine-need`; new work runs on the server
  [decision: sessions-placed-by-physical-need]. Concierge records each session's context and the Inbox topics
  it handles and shows them in search and context; the router chooses, and the receiving session
  judges fit: a request on a topic new to it says so, and it may hand it back (`--hand-back
  not-my-subject|too-loaded`, closing failed with a ready fresh-session command). Concierge never
  requires a reason or reads compactions as fit (`session-fit.ts`, [session fit](docs/architecture/SESSION-FIT.md);
  2026-10-07 [decision: router-decides-session-reuse] [decision: receiving-session-judges-fit]). `needs_you` and a `needs_decision` reply need
  `--his-words` (verified against his messages when they are in this ledger) and
  `--why-not-answered` [decision: questions-carry-his-words], plus `--only-he-can`
  sign-in|secret|device|ambiguous: permission, approval and design questions are refused
  [decision: act-then-tell]. A `completed` work reply needs `--all-done` and `--checked` or
  `--not-checked` [decision: agents-check-real-end-to-end-behavior]; when part of his request
  was not done, the work is not completed. These are folded into the words the requester and he
  read, so every carrier (return, peer, digest) keeps them. An Inbox topic request closes
  `completed` only when its latest dispatch answered as done (earlier ones only block while running)
  and no question for it is open (`refuseUnfinishedCompletion`): on 2026-10-02 one closed over
  "paid bodies not read". A dispatch serving several requests that fell short blocks none of them
  while another of its requests stays open or closes not-done, since that one owns the shortfall.
- Change the Inbox agent's standing behavior by asking the Inbox session itself
  (`sessions ask` at its exact address) to update its own `slack-inbox` instructions.
  Never edit its AGENTS.md from another session. A resumed Claude session keeps the
  system prompt it started with, so an edit made around it never enters its context;
  a change it makes itself does. Other sessions pick up new instructions when they start.
  Source: Tejas, 2026-09-18, after the Inbox never saw the turn-outcome rule.
- Tejas's report `a3601736-3f14-4659-80a0-583d13a3e68b` on September 16, 2026 moved the
  default provider to Opus after Codex credits ran out on a second account. One
  authority owns it: `DEFAULT_PROVIDER_ALIAS` in `bot/src/aliases.ts`, resolved through
  `configuredProviderDefault()` wherever a stored project/channel default is read. A
  project that selected its own provider keeps that selection, an explicit human
  provider/model/effort choice wins, and a running session keeps its binding. Do not add
  a fallback chain or automatic provider switching. When a session hands work down
  to a cheaper model or escalates a stuck problem up to a stronger investigator is
  owned by the global instructions' Model selection section; the per-turn prompt in
  `session-input-context.ts` carries its summary to resumed sessions, and Concierge
  code here is subject to it like any project. See
  [delegation and escalation](docs/architecture/PROVIDER-SESSIONS.md#delegation-and-escalation).
- The native Inbox interprets human intent, including “take a note”, “take action” and
  “ask ChatGPT”, without requiring magic prefixes. Ideas are not build authorization.
  Ambiguity asks the human. Note saves use the existing Thinkering capability host and
  original retained capture bytes; user edits survive retry. No extraction runner returns.
- Codex Remote mirroring handles inputs actually submitted by another Codex client.
  Match native provider input IDs against the common ledger and exact provider turn;
  human, agent and service inputs owned by Concierge must not be labeled Remote or
  exported through that observer. Native results belong in Thinkering and correlated
  request replies; an old Slack thread binding alone does not authorize mirroring them.
- Serialize execution through the existing per-session FIFO and provider owner. Keep
  preparation, request/return obligations, native Stop and recovery with their existing
  authorities. No arbitrary communication quota or reciprocal automatic request loop.
  Stop cancels its exact run; later messages and returns remain eligible in the same
  durable session. Preserve agent authorship and owner-resolved human provenance;
  a new input never replays the stopped input or an uncertain effect.
  Native provider-subscription failures use the shared structured logger; observation
  failure must not terminate the service or interrupt unrelated accepted turns.
- **A request closes only through a command, never through prose.** Agents are taught only the
  commands, once, in `REQUEST_PROTOCOL` (`bot/src/request-protocol.ts`), in the per-run
  instructions and `sessions --help`; the rules are enforced where they apply, not repeated. One
  Stop hook for every agent (`bot/scripts/owed-reply-stop-hook.ts`) sends it back once when it
  tries to end a turn owing a reply: Claude gets it with `--settings` on every run, Codex as a
  managed hook from `/etc/codex/requirements.toml` (`scripts/install-codex-stop-hook.sh`, run by
  remote-box's deploy on the box and by `install-mac.sh` from a terminal on the Mac), because Codex
  runs unreviewed hooks only from managed policy. There is no reminder turn and no weaker path for
  either provider; a request still stranded after the hook is reported stalled. Never put standing instructions into each input: the Inbox's 3,802-character preamble
  was prefixed to every input (1,019 copies, ~3.9 million characters, in one conversation) and now live in its per-run
  instructions; an input carries only its identity header and its own facts. The mechanism, its grounding (FIPA Request,
  transactional outbox), the enforcement table and the measurements are in
  [the request reply protocol](docs/plans/2026-09-23-request-reply-protocol.md). For engineers
  here: nothing in the owner may settle a request from a turn's text or silence (only ChatGPT
  and consultation-only turns, which have no reply command, answer with their turn);
  `request-liveness.ts` owns the stranded check and the stalled notice, and
  the recipient's machine runs them; an old inferred final (`isInferredFinal`) is superseded by
  a later explicit one (`superseded_by_event_id`); peer replies count as forwarded only when the
  origin confirms that exact event, and a pulled reply with files is fetched whole. Incident:
  September 23, 2026, 72 guessed closures in a week and a discarded Mac answer; Tejas: "Why
  can't the agent say this is his final reply? … Do you know about functions and determinism?"
- One recipient turn commonly holds several of a requester's questions: the first opens
  it and later ones steer in, and the recipient answers them together. When every input
  an acknowledged turn received is such a request, a sibling's explicit final reply
  written at or after this request arrived settles this one too, with that reply's text
  and disposition. A reply naming one request ID is not the only proof of an answer. A
  turn that carried anything else, a reply from another requester, and a sibling's reply
  to a request that sent its own partial never settle it. A sibling settled that way carries
  the same words, so it shares the answer's return rather than starting another.
  A steered request the provider never acknowledged follows its turn's confirmed terminal
  state, carries `STEERING_DELIVERY_UNCONFIRMED`, and still returns. It can still act as a
  source input for its exact live run. That citation is strong evidence of receipt but not
  proof (the input ID derives from a request ID another message can quote), so it records
  no acknowledgement.
  Any live run of the exact recipient session may reply to a request delivered to that
  session, so an answer after an interruption lands. Duplicate reply actions can be inspected after the run ends. An unanswered prerequisite
  holds its dependent request for a decision; it does not prove the prerequisite failed.
  A dependent the requester asked after that outcome reached it is the decision and is
  delivered; otherwise the requester cancels (`sessions cancel`) or asks again. A hold
  with no release path stranded requests silently for a day (September 17–19, 2026).
- Work running under a live owner, or a recipient session still running after the bound
  turn ended, is not a stall. The due-time inspection defers it to
  the next interval rather than waking the requester, and when a stall is real the
  requests one recipient turn holds report one health event between them, not one each.
- Final work replies declare `completed`, `failed`, or `needs_decision`. Declared
  completion settles and returns as soon as the reply is recorded. It used to wait for
  the answering run to end, which held answers for hours in a Claude session that takes
  new requests by steering into one long run (September 21, 2026); the recipient's
  explicit declaration is the confirmation.
  Every settled request with a requester input is carried by exactly one `return:<eventId>`
  input, including confirmed completion, even while the requester is mid-run; only a
  paused, archived or missing requester holds it. One answer reaches a requester once:
  finals to the same requester from the same session with byte-identical words and the
  same disposition share the first one's return, which names every request it closes, and a
  later identical copy joins the return already delivered instead of starting another
  requester turn. One answer closing five requests arrived as five Inbox turns and five lines
  on his screen (September 23, 2026). Identical bytes are the test, never similar words. Completion used to be retained
  without a return, and the Inbox silently lost 64 finished results on September 21,
  2026, so never reintroduce a settled-but-unreturned state. `session-return-audit.ts`
  logs `session_return_undelivered` (error) once for any settled result still
  unreturned after ten minutes. A run ended by his own Stop (a human `stop` operation naming that
  run, `stopped-by-tejas.ts`) settles as his stop: a quiet line in the Inbox thread it served, never
  a router turn or a notification; a cancellation without his Stop says so and asks for follow-up.
  A partial reply is not a result and wakes nobody: it is recorded on
  the request and read with `sessions get`, because each wake re-read the asker's whole
  conversation (one lab session, ~860k tokens per note, four times for one note, 2026-10-08). Legacy `retained` rows stay as history; the Inbox's
  rows from that day were re-delivered once in one digest reply, and rows the old runtime
  retained during rollout, or held waiting for their run to end, are released to return
  at startup. An
  unclassified work answer is `undetermined` and holds dependents. Never infer
  success from `requestedEffect`.
- **Every answer reaches its asker the moment it arrives; nothing is held to batch answers** (Tejas, 2026-10-08:
  "Please update as soon as one agent you get there. What if one agent is like doing some minor work and an another
  agent is doing two hours of work?" [decision: answers-delivered-when-they-arrive]). A stall or overdue notice is checked
  against the request at delivery and dropped when the request is already answered, and an answer withdraws a notice
  about it not yet taken up. A worker waiting on its own sub-request or watch started after the request is not stalled
  (`waitingOnDependency`). Every ask and final reply carries a one-line `--summary` shown first; `--answer-view
  summary` lets the asker see only it. See [exchange kinds](docs/plans/2026-10-08-exchange-kinds.md).
- Persist accepted intent before external effects. Retain exact action/input/run identity,
  verify current ownership, and preserve uncertain outcomes. Never replay completed work
  or resend an ambiguous provider effect merely because a response was lost.
- Deployment migration opens the ledger through `state-database.ts` and reserves one outer
  SQLite writer transaction before loading application and deployment schema. Deployment
  commands import that connection directly; they must not initialize unrelated application
  schema as a side effect of claiming or inspecting deployment ownership.
- Every attributable message carries the accepted input it belongs to as `inputId`, so a
  client threads a request to its replies from owner-established identity rather than
  page order; `submissionId` keeps its provider-submission meaning. Any owner read a
  client repeats is bounded by the owner: event reads take `kind`/`runId` sets and a
  `limit`, a client holding every receipt asks `changedAfter=<asOf>` and gets back only
  those still able to change plus new ones — decided from whether each receipt has
  settled for good, never from which events fired, since a hand-off's answer records no
  event on it — and receipt reads page, so unread state and Inbox receipts cost a page instead
  of the whole ledger. A receipt looks its request up with `find`, which answers null for an
  id no table holds (a project set-up's return, a Mac request the peer table dropped), so one
  such row never refuses the whole read: it did, for every Inbox receipts read from 2026-09-28
  to 2026-10-01, and his phone said "Request receipts could not be loaded." A client holding a page asks `history?after=<asOf>` for what
  changed. Answer it from what the page was built from, never the ledger alone: a
  provider transcript can hold a message the ledger never recorded. When the owner
  cannot answer truthfully it returns `reset`, never a partial delta. See the shared
  wire contract.
- A capture that answers a thread's question is placed there with `sessions thread`
  (`--detach` undoes it, and `unthread` is his own split control): an additive
  `thread_link` event, never a rewrite of the retained capture. The Inbox agent decides,
  only where it asked and is still waiting; the message then carries `replyToMessage` and
  `routedBy`. See the native Inbox contract.
- The Inbox agent answers a thread on purpose with `sessions post --thread`, a `post`
  ledger event. Tejas rejected threads that collect whatever the agent said while it
  worked. The owner resolves the thread root; a post starts no turn and owes no reply.
  Only ledger-backed history accepts posts, because a provider transcript never contains
  them. See the native Inbox contract.
- Session views and message metadata expose exact retained turn timing (start/end, provider acknowledgement and reported work duration). Missing historical duration stays unknown. Claude print-mode tool results retain error status and provider timestamps for the same operation display as Codex.
- A selected-message reply is an immutable human input carrying `replyToMessage:{kind:"message",sessionId,messageId,source?}`. Its session ID must equal the addressed canonical session; imported-source targets retain their source/version/event pin. It is presentation/provenance for the provider envelope, not an agent/service reply or a substitute for the existing `replyTo` request-return field.
- Codex lifecycle observation includes turns submitted by other authorized clients.
  Provider observation never creates an owner input/run or overwrites its terminal receipt;
  see [external lifecycle](docs/architecture/SESSION-OWNER.md#externally-submitted-codex-turns).
- Keep unread activity, declared attention, read/dismiss and outcome separate.
  Ordinary responses and failures do not set Needs attention. Every working turn declares
  once with `sessions outcome` and its exact source input/run and stable action ID: done,
  response with what to read, needs_you with the question, or failed with why. A turn that
  posted its answer needs no closing text. A turn another agent opened into an Inbox thread
  (a return, a request) must post there before declaring; the owner refuses the outcome
  otherwise and relays an unposted closing text into the thread itself (2026-09-24). A turn
  answering a message Tejas sent himself cannot end `done` without `--quiet-because "<why he
  need not read this>"`; the owner refuses it, raises an undeclared end to `response` so he is
  told, and shows the reason under the reply (2026-09-25, `answersHisOwnMessage`). Older sessions still use the exact final
  `[[outcome-k7q4:…]]` marker line (`turn-outcome-marker.ts`) when they have not declared
  by action. Tejas rejected a provider-enforced form because it doubled Claude turns.
  Only needs_you and response (an answer he must
  read, not routine replies), or a hand-off reply's
  `needs_decision`, raises attention, cleared by his reply, a later declaration or
  dismiss, never by reading. In the Inbox that attention is a question record in its
  topic, with a kind (decision or reading), an owner and an explicit recorded end; a
  outcome the run did not declare as a question is held unfiled until the router files it,
  never guessed into a thread ([design](docs/plans/2026-09-23-attention-that-ends.md),
  [contract](docs/contracts/native-inbox.md#topics)). **A question he sets aside may name when it comes back** (his `question` action,
  state `deferred` with `until`; `defer_until` on the row): `wakeDeferredQuestions`, on the owner's
  reading cadence in both compositions, returns a due question to open through the ordinary
  topic_question change, records a `needs_you` event shaped like a new question's so he is
  notified, and admits a service notice to the question's owner (the Inbox router for most)
  naming the thread, so it can refresh anything in the question that expires before he opens it;
  his `open` state brings one back by hand (Tejas, 2026-10-07: "remind me later … 30 minutes, 3
  hours, 6 hours, one week") [decision: remind-me-later-on-questions]. **The open-threads list is ordered by
  what needs him** (`listTopics`: a decision or something to read first, then work moving, then unread, then
  the quiet rest, newest first within each by the conversation's own time; closed threads by `closedAt`), **a
  thread's time, newest entry and unread mark come from its conversation alone** (his messages, posts and
  returns under its roots), never from housekeeping events, which stay in the Timeline (withdrawing 39 stale
  questions on 2026-10-07 had dated a Sept 22 thread 4:17 PM), and **reopening a thread brings
  back the questions its closure ended** (`restoreExpiredByClosure`, his reopen and the router's alike), so
  the Threads list's one-tap close can carry an Undo that loses nothing (Tejas, 2026-10-07: "everything is
  kind of cluttered and dumped on the main page here. Clean it up.") [decision: tidy-inbox-threads]. **A reply he types inside a thread goes to the agent working on
  it, not to the router** (`replyTargets` in session-topics.ts decides from the thread's record and the
  app shows the choice; `SessionOwner.threadReplyTarget` applies it on the send; `forwardReply` in
  session-communication.ts carries his words as a request to that agent, closed only by its own
  `sessions reply`, each reply posted into the thread as the agent's words by `postForwardedReply`; the
  router is woken by none of it and stays a choice he can address) (Tejas, 2026-10-07: "I should just
  be talking with the agents who are working on this thread … my responses go back to the same
  session") [decision: thread-replies-go-to-the-working-agent]; design in thinkering
  docs/plans/2026-10-07-reply-to-who-asked.md. **A session on his Mac is a session, in every
  feature** [decision: mac-sessions-have-parity]: `replyTargets` offers a `mac:<n>` agent from the
  peer catalogue (`peerSessionView`) exactly as a local one, `forwardReply` carries his words to it
  as a peer work request under the Inbox's identity with the same framing (`forwardedReplyFraming`),
  queued while the Mac sleeps (his message says so, `PEER_ASLEEP`) and delivered when it wakes, and
  `SessionPeers.deliver` posts the Mac agent's answers into the thread through the same
  `postForwardedThreadAnswer`. The first build offered server sessions only and he rejected it the
  same evening ("Mac needs to have the same parity as we have"); a feature that addresses, lists or
  delivers to sessions and leaves the Mac out is not finished. **An agent's answer to work the
  router sent for a thread goes into that thread, not to the router** (Tejas, 2026-10-07: "I do not
  see a reason why you need to receive a response at all") [decision: agent-answers-go-to-the-thread]: each partial and final reply is posted
  there as the agent's words through the same poster (`postAgentAnswer` in session-topics.ts, called
  by both deliver paths), and a final files his item with its notification (a question for
  `needs_decision`, a reading item otherwise) and closes the linked thread request when it answered
  done; no `return:` reaches the router, which reads the posts in its `<topic>` block
  (`agentAnswers`). Hand-backs, stalls, the owner's settlements and information answers still return
  to the router; see the session-owner contract. A service notice (no provider turn
  behind it) is the exception: the owner files it into a thread titled by its own first
  sentence the moment it exists (`fileServiceNotices`), because no router turn will ever
  see it and a notification must always open a thread (2026-09-25, the Codex App Server
  notice that opened on "not in a thread yet"). The notice is that thread's conversation
  (author `service`, `communication: 'notice'`), he can reply to it, and when its breaker
  clears the owner posts "running again" as a service post and closes the thread
  (`resolveRetryNotices`); notice text is written in his time zone (`noticeTime`) and
  never names a file path. The legacy marker is stripped before display; a turn without a declaration is
  `finished_without_saying`. Never match outcome words or `@Tejas` in prose. See the shared wire contract. Project their activity once;
  stale observations cannot hide later work or recreate dismissed notifications.
- Session outcome is durable working-set state: `done` means done for now and reopens to
  `open` only when the owner binds a new human or agent input to queued execution or live
  steering. Retained-but-held inputs, service returns and incidental controls do not
  reopen it. `shipped` remains distinct and is never reopened automatically. Active
  working-set clients filter conversations by `outcome=open`; execution is independent.
- Claude history reads resolve the bound provider UUID through the SDK across project
  directories; current execution cwd is not transcript storage identity. Project a
  provider-observed steering message from its unique accepted input and exact retained
  replay bytes when Claude assigns a different row UUID; the JSON identity header is
  transport, not chat content or authority. A Claude user row is a message only when
  Claude records who submitted it (`promptSource` `sdk` from the owner, or `typed`).
  Interruption notes, model-switch records, background-task notifications, compaction
  notes and other CLI bookkeeping are never messages: in a session this owner drives,
  anything a person or another session said was submitted through the owner, so history
  drops a user row it cannot attribute and the live stream publishes one only when its
  text is exactly one the run wrote to Claude or a person typed it. Claude marks queued
  notifications as replays too, so the replay flag proves nothing (2026-09-21). Imported and reconstructed sessions
  keep their unattributable rows. Decide by that recorded author, never by wording: matching one
  interruption phrasing missed the next, and real messages can start with a bracket.
  A turn's opening input is proved the same way and must not wait for the provider to
  echo it: the transcript can show the message first, which rendered it as an unknown
  author with its header as text. Only header-stamped bytes are unique by construction,
  so ambiguous or headerless bytes fall through to the older joins. A delegated message
  shows its whole chain — sender, the human request it acts for, and work versus
  information — never less than its operation receipt already resolves.
- Archive discovery retains exact source bytes through the source capability before
  materializing a returned catalogue candidate. Pure index searches do not copy archives;
  changed or unavailable candidates remain explicit coverage omissions. The retention proof
  is one page of Thinkering's prepared history for that exact version (`retainArchiveSource`),
  never a `context` read: context re-reads and serializes the whole snapshot on every search,
  and a 289 MB transcript cost 5.8 s and 120 MB per candidate, making one search take 10.2 s
  (supervisor incident 708b0814, 2026-10-08).
- Source history is cited evidence. Verify exact source/version/branch/event membership.
  Catalogue projections distinguish unbound imported `historical-evidence` from
  conversations; discovery never promotes evidence into active work. Reconstructed
  consultations and explicitly bound imports remain conversations. The wire contract
  owns the classification and backward-compatible surface rule.
  An imported Claude/Codex source with a native UUID may continue through resurrection
  on the machine holding its recorded folder and provider transcript. The owning machine
  binds one native session to that UUID; peer archive resurrection still makes a distinct copy.
  Historical consultation is information-only, with no tools, network, writes or outbound
  requests. Preserve the source and the restricted child identity across follow-ups.
- ChatGPT uses the existing private profile, transcript custody and browser capability.
  Deliberate provider choice and same-provider failures remain visible. Operator-owned
  daily refresh and explicit refresh use the common owner; no competing browser or index.
- Thinkering's workspace records and published proposals stay untouched by convergence.
  Do not import discarded extraction bookkeeping, replay old jobs or reapply workspace
  effects. Retired development controls stay retired; independent browser/phone code-only
  rollback must remain available without an agent session and must preserve notes.
- Use isolated task worktrees for concurrent changes. Code and host configuration travel
  through their Git origins; host services belong in remote-box. Never hand-edit installed
  units or copy source into a service checkout.
- The managed pre-command guard refuses writable delegated Codex CLI launches from a
  repository's canonical checkout and gives `wt <task-name>` as the recovery command.
  Read-only reviews remain allowed. During deployment, the runner commits modified
  and untracked shared-checkout files to a timestamped preservation branch and linked
  worktree before pulling and posts the file list and location to the native Inbox's
  Needs attention path without a provider turn; a failed preservation stops the
  update with its Git stash retained. A recorded Git-update failure gets one retry
  after the checkout is clean, checked by the owner once per minute without a push.
- **Every commit carries an `Update-note:` line — one sentence in product language about what
  that change does, addressed to him, no code terms. Documentation is included: an instruction
  change alters how agents behave, which is exactly what he wants to know about. `internal` is
  retired.** He threw it out on 2026-09-23, reading a notice that
  hid a change because its author had marked it invisible: *"I do not understand what you mean by
  changes. Nothing you see … I'm not asking for updates only in the visual aspects of it. I need to
  understand, look, what the back end is going … every single thing that is, we are changing, every
  update is gonna matter, right? It's a change that you're making. What is it? … Yes, maybe I don't
  visibly see, but who cares? That's not what the updates are talking about. Do you think every
  single feature that we're launching here is like something that I visibly see?"* So a change to
  how a conversation picks its account is described exactly like a change to a button: "a
  conversation now keeps the account it started on". Say the
  consequence when waiting has one ("until this lands, questions you cannot answer still count
  as waiting on you"), because that is the only honest way he can tell an urgent update from a
  routine one: no severity is derived anywhere, and a label nothing populates would be worse
  than none (his question, 2026-09-22: "I can't tell how important it is for us to install
  that"). thnkr.ing shows those sentences,
  and only those, while a Concierge update waits for his sessions to finish, so he knows
  what is about to be applied; commit subjects are shown only when a change has no sentence. A note can be added
  to an already-pushed commit with `git notes --ref=refs/notes/update add -m "<sentence>"
  <commit>` followed by `git push origin refs/notes/update`, and that note wins.
  `release-history.ts` reads them, never remembering one, so a note written or corrected while
  an update waits reaches him on the next read; the wait payload carries them. **Write the note
  when you commit.** The `post-commit` hook says so, to you, while you are still there; it warns
  and never refuses, because a missing sentence must not stop a fix from shipping (Tejas,
  2026-09-22). Release time is too late to start: the release asked the authoring session, and
  on 2026-09-22 that ask sat in the queue of a session whose running work was itself blocking the
  release, so he was shown a waiting update and nothing about it, twice in one evening (captures
  `d0781019`, `d5881417`). That mechanism is removed. **An update is never hidden from him**: a
  change still missing its sentence is shown with its own commit summary instead, which is ours to
  close, not a reason for his notice to stay silent. A note pushed from another machine is not
  readable here until `refs/notes/update` is fetched into this checkout. The note is read whole:
  an editor wraps a long sentence at the commit margin, and reading only its first line published
  half a sentence to him three times in one evening.
- **An update that failed says so, until one succeeds.** `status.deploymentStuck` is every
  deployment run since the last successful one, with where the runner stopped, whether a repair is
  running or parked, and what the whole uninstalled gap brings; thnkr.ing shows it on the same one
  update line. A fresh attempt does not retire it, because nothing is installed yet. Four failed
  updates on 2026-09-23 were invisible to him for exactly that reason — nothing was waiting once
  each one gave up, so the line showed only the app update ("why do I not see the Concierge update
  notification at all?", capture `c60c6162`). **A deployment target that no branch has is abandoned, not chased.** A force-push leaves the
  commit a webhook recorded on no branch; every deployment then installs main, ends with that
  commit still unmet and starts the next one. Nine ran in eleven minutes on 2026-09-23, each
  restarting the service and draining his sessions, while his update notice never cleared
  (capture d526a570). `observeDeploymentDesiredCommit` cannot see a rewrite — every later push
  reads as `divergent`, so the unreachable commit is kept forever — and the worker now resolves
  the desired commit against the repository before asking for a run, adopting main's head once
  and saying so in the log (`deployment_desired_commit_rewritten`).
- An update that never started is the same fact: a commit that should be
  running, with no attempt in flight and none for longer than a deployment takes to begin, is
  reported with no attempts to count — today's failures began exactly there, with a wake loop
  that kept the runner from starting. Anything that changes how a failed or unstarted run is
  recorded keeps that read working, and nothing may claim a retry the record does not show.
- **A Claude run on the server lives in its own execution host, not in the Concierge service**
  (`bot/scripts/execution-host.ts`, one `concierge-exec-<id>` systemd unit per run, journal under
  `$CONCIERGE_STATE_DIR/exec/`). Restarting Concierge leaves it working; the next Concierge takes it
  back by identity at startup (`claimAdoptableExecutions`), before steering and turn recovery, and
  replays the host's record to rebuild its state. The host holds no policy and is never patched in
  place; never restart, kill or "clean up" `concierge-exec-*` units by hand: they are agents at work.
  Every new Codex turn runs on the shared App Server and is followed by its exact ids after a restart.
  An update waits only for runs that would end with
  Concierge: a kind of run stops holding updates once this machine has seen one of that kind alive
  at takeover and then finished (`execution-survival.ts`, one rule for the gate, the queue and the
  update line). On the Mac each Claude host is its own launchd job started through the agent-host app. See
  [execution host](docs/architecture/EXECUTION-HOST.md).
- **An agent that must wait for a file, directory or command registers a watch and ends its turn**
  (`router-actions.sh sessions watch …`, `bot/src/watches.ts`): one polling worker per machine inside
  Concierge wakes the exact session once with a retained observation, records restarts and sleep as
  gaps, and runs a watched command as an execution host that never holds an update. See
  [watches](docs/architecture/WATCHES.md).
- **The lab's board is its record in thnkr.ing** [decision: lab-knowledge-lives-in-the-thinkering-object-store]
  (`router-actions.sh sessions board …`, `bot/src/commons-board-service.ts`): threads, entries, findings, decisions, skills,
  citations and typed links live in Thinkering's object store, in a lab journal kept out of his everyday views, each with a
  lasting address down to the paragraph (route contract: thinkering docs/plans/2026-10-08-lab-record.md). Concierge only
  proves the writer (the route asks this owner which session holds the run in `X-Concierge-Agent-Source`) and delivers the
  `notify` list each write returns: a local session by a notice admitted under `lab:<address>:<why>:<session>`, a Mac session
  by an informational request. The plain-file board of the same morning was reversed by him
  ([decision: agent-discussion-board-readable-without-concierge] is superseded); /root/workspace/lab-commons is history.
  Writing needs the server's agent key, so board writes run from server sessions.
- **The lab runs inside Concierge in its own space** [decision: lab-runs-inside-concierge-in-its-own-space]: a session
  created in agent-ecology (including any folder inside it, such as `agent-ecology/expertise/<name>`), lab-commons or any `expertise-*` folder is lab work (`sessionSpace` in session-roles.ts),
  every session view carries `space`, `GET /sessions?space=` filters, and `GET /lab` lists the lab's sessions and
  every request touching it with how it ended. thnkr.ing keeps lab sessions out of his everyday list, Inbox and
  notifications and shows them in its Lab view. An experiment that changes Concierge itself runs on a separate
  instance. See [the lab space](docs/plans/2026-10-08-lab-space.md).
- **A session can live in a folder inside a project** (Tejas, 2026-10-08: "Why do we have an expertise folder in the root workspace?" [decision: lab-work-lives-inside-agent-ecology]): `--project` on ask and create accepts `<project>/<folder>` or its absolute path (`sessionProject` in session-projects.ts; the folder must exist inside the project), and `sessions move <address> --project …` re-homes an idle session, whose next turn resumes the same conversation in the new folder (each turn reads the folder from the session record). Lab work lives inside agent-ecology, never as top-level projects.
- Concierge delivery ends at the normal push to `origin/main`. End the provider turn so
  the existing detached worker can reach an idle boundary. Do not manually restart the
  service, wait for its deployment, add a deployment waiter, or restart the shared Codex
  App Server. The established deployment/repair owner handles rollout and health.
  Human input `1789510460.238219` explicitly authorizes the bounded native Inbox recovery
  exception: `bot/scripts/native-pipeline-continuation.ts` enrolls the current live source
  before yielding; remote-box's single safeguard observes deployment readiness/deadline
  and admits one service continuation through the existing native queue. It never
  deploys or runs a provider. Stop/pause/archive cancel it. See the native Inbox contract.
- Signing Codex in is asked of Codex, never read off its console. `codex-device-login.ts`
  calls the App Server's `account/login/start` (`chatgptDeviceCode`), which answers with
  `verificationUrl` and `userCode` as fields, reports approval through the
  `account/login/completed` notification, and withdraws an abandoned attempt with
  `account/login/cancel`. The daemon performs the login itself, so it already holds the
  token: nothing here writes a credential file and no restart is needed, only the release
  of parked work. The scraper it replaced expected a four-and-four code, Codex 0.153.4
  prints four-and-five (`S8AM-GKSLB`), and Tejas was shown an empty box with no way to
  finish (September 22, 2026). Never parse a human-facing transcript for a value a
  protocol will hand over. Claude Code keeps the bounded CLI adapter in `auth-login.ts`
  because it documents no structured login; its approval code arrives through the app's
  own field, never from him reading process output. Where that adapter must read the
  transcript, it reads exactly, never by a heuristic about what the value looks like: the
  same file cut every Claude sign-in link at `redirect_uri=` for three weeks, because it
  trimmed each URL at the second `http` and Claude's authorize URL carries an encoded
  `redirect_uri=https%3A%2F%2F…`. Anthropic rejected every one of those links, so no Claude
  sign-in through this path had ever completed, and he found it during an outage a sign-in
  would have ended (2026-09-22). A URL may contain a URL; a code may be grouped any way.
  Parse what the shape actually is, or do not parse at all.
- Provider credentials are owned by `provider-accounts.ts` (which account is on disk,
  named credential snapshots) and `provider-activation.ts` (making a change effective).
  A credential write and its activation are one owner operation, because Codex reads
  `auth.json` once at App Server start and keeps that token in memory. Activation is the
  one sanctioned App Server restart: it is requested by the human through Thinkering's
  Provider accounts surface, it defers while any Codex turn is running, and it is issued
  by the bot so it inherits `concierge-bot.service`'s `LimitNOFILE`. A daemon started from
  an interactive shell inherits that shell's 1024 and exhausts it re-opening observer
  subscriptions, which is why this restart must not be done over SSH. Any `codex` command in an SSH
  login can be the one that starts a stopped daemon, so Concierge also raises the daemon's soft
  open-file limit to its hard limit every time it connects (`codex-daemon-file-limit.ts`); one such
  daemon ran out at 1,024 and failed the 2026-10-07 7:24 PM update restart. The same step moves the
  daemon into its own systemd scope, because it otherwise dies with whatever unit or login started it
  (2026-10-08; [the runbook](docs/runbooks/CODEX-APP-SERVER.md#the-daemon-lives-in-its-own-scope)). This does not permit
  an agent to restart the App Server for any other reason. The owner itself makes the same switch
  when the Codex account in use has spent an allowance window and another kept account has room in
  every window, once no Codex turn is running (`moveCodexOffSpentAccount` in session-execution-host.ts;
  Tejas, 2026-10-08, capture f48861f1: "extend the same Claude code automation for account switching
  here to Codex too") [decision: provider-accounts-switch-automatically]; nothing is said to him about it, and the usage warning says Codex moves by itself.
  That surface covers every instance, not only the one serving the page: the auth routes
  take a `machine`, and a call for the peer is forwarded over the existing peer channel to
  the peer's identical route, where its own Concierge runs the login. Neither instance ever
  writes the other's credentials, and a machine that is not answering is shown as such
  beside the one that is rather than hidden. See [peer instances](docs/runbooks/PEER-INSTANCES.md).
- For Claude, pressing an account selects the home for future turns. It never calls the
  credential-copy activation or snapshots the outgoing credential. Extra accounts launch from
  their own homes, and once any exists agents never run on the main folder's login: a hand
  `claude auth login` or `/login` there replaces that login with no copy, so it is the
  terminal's alone (`claudeRunsFromOwnHomes`; it silently displaced his personal account at
  19:31 UTC on 2026-10-07). **Changing account never takes an
  ability away from agents** [decision: account-change-keeps-agent-abilities] (Tejas, 2026-10-07: "if the login has changed, the agents are losing
  access to doing things, that ... never should happen"): an extra home keeps only its login
  (`.credentials.json`, `.claude.json`, `.account-email`, remote settings and policy limits) and
  links every other entry of `~/.claude` (settings and allowed commands, instructions, hooks,
  skills, agents, plugins, history) by name, the same files the CLI uses when `/login` swaps only
  the sign-in (`sharedClaudeHome`). A home missing any link is never used and logs what it lacks.
  The account check (`claudeAccountWorks`) runs Claude as agents run and requires a Write and a
  Bash change outside its folder, read back by the owner, and names the failure (signed out,
  settings not in effect, wrong account, timeout); a reply-only probe passed for a home without
  settings on 2026-10-07. Automatic moves go only to a home proven by that check or by a finished
  turn from it; a sign-in refusal or a newly filed login withdraws the proof. An expired sign-in
  is renewed without him: one repair notice per account per episode, and the owner sends the Mac's
  browser agent a request to sign it in through thnkr.ing Accounts in his Chrome
  (`signin-renewal.ts`, Codex too; [sign-in holds](docs/architecture/PROVIDER-USAGE.md#sign-in-holds)). Pressing
  Switch prepares the links, runs the check from the proposed home and checks Claude's reported
  account identity before recording the choice. A credential file and a usage reading alone do not
  establish that its expired OAuth login can renew. A failed probe leaves the previous
  selection and running processes alone, with a safe sign-in reason on the account row.
  A successful probe may refresh the token inside that same home through Claude itself;
  Concierge never copies or rewrites it. An existing path to different history is
  refused without replacement. The account chosen for a turn is retained through its
  failure handler so an OAuth refusal reaches the existing sign-in hold rather than
  becoming a turn-setup error. Codex's
  App Server activation still follows the established credential path. See
  [provider usage](docs/architecture/PROVIDER-USAGE.md#which-account-a-conversation-runs-on).
- A machine holds exactly one active Codex login, `~/.codex/auth.json`, and one home per
  other account under `~/.codex-accounts/<name>/`. Those homes are not backups: each is the
  only live token the machine has for that account, and they are where the usage reader gets
  every account's limits, which is why two accounts' bars can appear at once.
  `~/.codex/retired-auth/` is an archive of superseded logins and holds nothing usable.
  Signing in inside `~/.codex` deletes that home's credential first and can make OpenAI
  revoke the account that was there, losing it for good. That rule was already written in
  [usage limits for every account](docs/architecture/PROVIDER-USAGE.md#usage-limits-for-every-account),
  and the Accounts sign-in was built on 2026-09-22 without reading it; it cost Tejas a live
  account and its usage reporting. Read that section before changing anything that signs in,
  switches, keeps or snapshots an account. A login is never copied, for either provider: a
  copy dies the first time the original renews. Codex switches move logins and succeed only
  when the running daemon renews as the chosen account; Claude sign-ins happen in a fresh
  folder and are filed under the account they turned out to be (2026-09-29, both server
  Codex logins and the chann.app Claude login lost to copies).
- A kept account's name is recorded beside it, never inferred from whoever is signed in.
  A Codex credential names its own account; a Claude one carries no address at all, so the
  code that labelled it read `~/.claude.json`, which is the global record of the *current*
  sign-in. Every kept Claude account therefore wore the current account's email: his
  personal account sat in the list as `tejas@chann.app`, which read as one account listed
  twice and would have switched him to the wrong one (2026-09-22). Claude homes keep
  `.account-email` beside their credential; the default login keeps its own identity.
  Whether the account selected for new work is current is decided by that address and the
  owner's durable selection — a refresh token rotates and its fingerprint stops matching, which would
  list the account in use a second time. An account kept before a name was recorded recovers
  its address by applying `profileId` forward to the addresses this machine already knows
  (the usage reader lists every Claude account by address) and matching — an equality check
  on a function we own, not a guess at a slug. Showing the filed name instead was shipped
  knowingly for one evening and was wrong twice over: a usage reading is keyed by address, so
  the same row also claimed its usage had never been read while that account sat at its
  weekly limit, and he read the screen as broken (2026-09-23).
- **A value more than one place needs has exactly one home, and something refuses the
  second copy.** This is DRY as Hunt and Thomas stated it — "every piece of knowledge must
  have a single, unambiguous, authoritative representation within a system" — which is about
  knowledge, not about text that looks alike. Models live in `aliases.ts`: id, provider and
  the name Tejas reads, with everything else deriving from it, and `/sessions/v1/models`
  publishing it so no client keeps a list. Enforce in this order, strongest first: derive it
  so a gap cannot compile (`MODEL_LABELS` is keyed by the literal union of the model tables,
  so an unnamed model is a build error); publish it so a consumer reads instead of copying;
  refuse a second copy with a check. **A derived guard is only real once you have watched it
  fail** — the first version of that union went through `PROVIDER_ALIASES`, whose `model` is
  typed `string`, so it widened to `string`, accepted anything, and passed a deliberately
  broken build. A client that cannot reach the published list says so and offers the
  default; a remembered fallback list is the second copy in disguise. Source: 2026-09-23,
  when Concierge moved to Opus 5.5 and thnkr.ing's picker kept offering Opus 5 — "we need to
  make this architecturally impossible". The inventory of every other duplicated value, what
  was fixed and what is still open, is in
  [one source of truth](https://github.com/tejasdc/thinkering/blob/main/docs/plans/2026-09-23-one-source-of-truth.md).
- A banked allowance reset is spent without asking, but only when work has actually
  stopped. Tejas reversed "nothing ever spends one for you" on 2026-09-23 ("You don't have
  to wait for me to reset the usage"). `provider-reset-policy.ts` holds the rule as a pure
  function so it can be read and run without a provider: it fires from the hold path, and
  needs work really stopped (not forecast), no other account of that provider with room —
  his "especially if both our accounts are running low" — and a reset still on the blocked
  account. Whether he has acted, or is awake, is never inferred; the only thing read is
  whether a grant is still there when work stopped, because waiting for him is the stall he
  asked us to end. One is never spent twice: the decision is recorded under the exact hold
  episode before the attempt, and across machines the provider is the lock, answering
  `alreadyRedeemed` — treated as someone already did it, never as a failure. Afterwards the
  held work is released and one notice says which account, why, and what is left. Only
  Codex grants these; Anthropic publishes no per-account list to spend. The Accounts button
  stays for when he wants to spend one himself. See
  [banked resets](docs/architecture/PROVIDER-USAGE.md#banked-resets-so-none-of-them-lapses-unused).
  **A grant is spent only against a spent weekly allowance, never early.** Tejas cancelled the
  pre-expiry spend hours after it shipped (2026-10-08): "we're not resetting before hundred
  percent dude … we only use actual resets for the whole weekly consumption … please do not
  build any sort of spending reset on whatever before it expires at all." The at-risk window,
  the used-percent threshold, the last-hours override and the agent-callable `sessions
  reset-credit` command are removed; nothing spends because a grant is about to lapse, and no
  agent can ask for one. `decideAutomaticReset` additionally requires the blocked account's
  weekly allowance fully used, or his one exception: the five-hour window exhausted while the
  weekly is at or above `WEEKLY_ALMOST_EXHAUSTED_PERCENT` (95%, conservative because a grant
  cannot be got back). **A five-hour wall never spends one** — that window refills on its own
  and held work already carries the instant it clears; `provider_usage_hold_released` fired
  three times in the 36 hours to 2026-10-08 releasing 6, 7 and 3 held inputs, no grant
  involved. A window this cannot identify in the reading stays null and null never argues for
  spending, so an unreadable weekly refuses. What a grant clears is still recorded rather than
  chosen: the grant carries its own `reset_type`, the consume call takes only a credit id, and
  the response reports `windows_reset` afterwards.
- A usage limit is scoped to the account that earned it (`usageScope`). Never reintroduce
  an account-independent scope: a limit that outlives its account refuses every dispatch
  locally, and the only escape becomes an operator remembering `provider-usage.ts clear`.
  That command remains for a genuine top-up on the same account; clearing it, and
  activating a different account, now also release work that was waiting on the old
  account's reset.
- An input the provider never received is not failed work, and a refusal that states when
  it clears is a wait rather than a death. A usage refusal carries that instant
  (`clearsAtMs`), the turn waits in its own queue for it under every existing
  effect-safety check, and the queue arms a timer for the soonest scheduled attempt —
  the native-only runtime has no periodic poll, so without that timer a wait with a known
  end has nobody to come back for it. A refusal with no stated reset stays terminal;
  never guess a clearance time. Never widen this to an acknowledged or ambiguous failure.
- A sign-in refusal before any assistant output or tool work is also a wait, even when the
  provider cannot say when the credential will recover. The exact input stays at the head
  of its own queue and resumes only after the selected account answers following sign-in,
  activation or a credential file change. A provider-free outage event tells Tejas once
  which account and machine stopped and how much work is waiting. Ambiguous or worked-on
  turns remain outside this path. See [provider usage](docs/architecture/PROVIDER-USAGE.md).
  Owner sign-in, add and switch activate directly; external credential files and the Mac
  login Keychain use filesystem events, and a deferred Codex activation follows the
  execution-change event. Startup checks once. The three-minute fallback exists only
  while work is held until real external sign-ins on both machines prove event release;
  every release records its signal in the log and the outage resolution event.
- A confirmed provider refusal after assistant output or tools keeps the failed turn in
  history and queues one new service continuation under that turn's identity. The original
  input is never replayed: the next run checks its transcript and external effects before
  resuming. Usage, rate and sign-in continuations use the same queue releases and
  provider-free episode notices as holds. Stop, pause, archive or a later human/agent
  input cancel a queued continuation. The same `queueTurnContinuation` entry point takes
  a distinct boundary reason for work intentionally yielded before deployment, and an
  `interrupted` reason for a Codex run cut off from outside after it had worked: its app server
  restarting to update itself, or the no-activity limit after a Mac's lid closed mid-run (mac:69,
  2026-10-01). A continuation that is itself cut off is not continued again. Startup
  catches only recent, evidenced worked-on provider refusals. See [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md).
- Both runtime compositions sweep running turns stranded by their own coordinator while excluding active queue and provider work. Proven never-admitted turns return to their FIFO, or stay cancelled after Stop; uncertain effects stay interrupted for reconciliation. See [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md).
- Work that stops must say so on a path that does not depend on what broke. A usage hold
  publishes one `provider_outage` event per episode (`provider-usage-notice.ts`) naming
  the reset, how much is waiting and which other accounts have room; Thinkering pushes it
  with no provider turn and no router session. On 2026-09-22 the notices were themselves
  the nine destroyed inputs — the returns reporting the outage ran on the exhausted
  account — and he found out by asking. See
  [the incident](docs/incidents/2026-09-22-usage-limit-silent-stop.md) and
  [provider usage](docs/architecture/PROVIDER-USAGE.md).
- A usage reading is not a display. Every reading is kept and forecast
  (`provider-usage-forecast.ts`); a window the provider does not project itself — the
  five-hour one, the one that broke — is projected from this machine's own samples, and
  every forecast carries its source, samples, span and rate. Never state a countdown: a rate
  cannot promise a time. Readings tighten to five-minute cadence near a wall because two
  samples cannot draw a line, and both runtime compositions start the watch.
- Work that is about to stop is told before it stops, not after: Tejas once per account per
  allowance period, only when the account reaches 90% of a window and never from a pace or
  forecast [decision: usage-notice-only-at-90-percent], as a provider-free Inbox notice with its own
  thread and push (a bare outage event never reached him: thnkr.ing sends those only for held
  messages), any caller through
  `router-actions.sh sessions usage`, and sessions through their own context. A turn that
  starts while the account is low reads it in its per-turn instructions; a turn already
  running is told inside that run, pinned to that exact live run so a notice about spending
  can never itself start a turn, once per session per period. It informs and asks; it never
  instructs, and a running session keeps its model binding — Tejas settled that on
  2026-09-23 ("we don't have to switch to our cheaper model suddenly"). Delegation should
  cross providers: a session low on one is told where the other has room. Each Claude turn
  now chooses among this machine's readable accounts with shared conversation history, while
  a running process keeps its own home and credentials untouched. The last account is a
  preference, never a permanent binding; only banked work can bind to one account. A
  one-home machine retains its existing dispatch path. See
  [provider usage](docs/architecture/PROVIDER-USAGE.md).
- **Nothing is said to him about which account a turn runs on.** Not a start, not a switch that
  worked, not a move onto the account he selected. Picking an account with room is the whole job
  of that rule, and a rule doing its job is not an event. He is told exactly once, by the existing
  usage hold notice (`provider-usage-notice.ts`), when work is actually stopped — every account
  out, or a banked turn's own account out — and that notice says what is waiting and until when.
  He removed this category in three steps on 2026-09-29, each after a narrower version: 27
  banners naming the account he had selected himself ("We did not change the accounts"), then a
  move he had caused ("I'm the one who fucking selected that … Am I a fucking idiot?"), then
  "What the fuck does it matter for me if you ran on one account or not? What matters for me is
  … we never face an issue of an user is running out" — and then the correction that keeps the
  one that matters: "Why would you remove run out? … Use some fucking discernment here." The
  choice is still recorded on the turn (`kind:'account'`, with the reason and the expected
  account) for diagnosis, with no words in it. `claudeAccountNotice` is retired and written null
  so old ones clear; the app's banner, component and field are gone. See
  [interface-decisions D20](https://github.com/tejasdc/skills) and
  [provider usage](docs/architecture/PROVIDER-USAGE.md#which-account-a-conversation-runs-on).
- **Concierge never forces a conversation to summarise early**: Claude keeps its own default
  compaction point [decision: agent-conversations-are-not-condensed]. Token measurements and the
  measuring script are in
  [how long a conversation may grow](docs/architecture/PROVIDER-USAGE.md#how-long-a-conversation-may-grow).
- A conversation that has filled up is not a failure to show him. Claude's `Prompt is too long`
  is recovered in place: `/compact` into the same live process, then the turn's accepted inputs
  replayed verbatim, once per turn and only when no tool has run. Auto-compaction is on and
  works; it simply races the request, and his two-sentence message lost that race at ~979k of
  1M on 2026-09-22. Compaction is a user message, not a control request — the SDK declares none
  at 0.3.263 — and the CLI's exact reply sequence is recorded in
  [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md). A compaction that fails, or a refusal
  that is not about the window, surfaces unchanged.
- A wiped deployment registry must not be repaired by restoring the entire SQLite backup,
  replaying an interrupted run, or fabricating its missing incident/review result. The
  exceptional operator recovery in [the deployment runbook](docs/runbooks/DEPLOYMENT.md)
  verifies a proven backup LKG and reserves the control handoff in one transaction before
  admitting desired-state work; its human-policy exception is distinct from `SHIP`.
- A release's control files are declared once in `bot/src/deployment-artifact-files.json`.
  Add or remove a control file there, never in code: releases are built from the packaged
  source's declaration and verified against their own sealed manifest, so a list change can no
  longer strand deployments (September 21, 2026). A control that still rejects its own LKG
  recovers through "Self-verification controller recovery" in the deployment runbook.
  Every declared destination stays under `control/` (bundles for agents' router and hooks
  live at `control/bot/scripts/`): the installed control checks the candidate's list before it
  builds anything, so a destination it refuses stops every later update. That happened to
  three updates on September 24, 2026; see "Artifact contents" in
  [deployment repair](docs/architecture/DEPLOYMENT-REPAIR.md).
- Deployment builds use only the pushed desired commit in the deployment-owned source
  under `/var/lib/slack-concierge-deployment/source`; the agent checkout is not pulled,
  stashed, checked for cleanliness or used by live router and hook launchers. Installed
  release bundles own those entrypoints. Shared-checkout preservation events are
  historical; the Codex worktree guard remains for concurrent agent writes. See the
  [deployment runbook](docs/runbooks/DEPLOYMENT.md). Every reader of that source creates it
  when missing (`ensureDeploymentSource`), because the bot's check for a new version runs
  before any deploy and, when only `deploy.sh` created it, could never request the update that
  would (September 24, 2026). Never create or edit it by hand.
  Host-owned one-shot callers use the release's bundled router, notice and native
  continuation commands. Declare a new caller's bundle in the artifact file before
  pointing a host unit or script at it; the agent checkout is never a runtime path.
- **Pushed history is never rewritten, and the system refuses it.** No forced push, and no
  amending or rebasing a commit that is already pushed; a pushed mistake is fixed with a new
  commit. Rebasing, amending or resetting unpushed work stays allowed. Three layers, one rule:
  `bot/scripts/history-guard.ts` (decision in `history-rewrite-policy.ts`) refuses the command
  before it runs, for Claude through `--settings` on every Concierge run and Claude's managed
  settings, and for Codex as a managed PreToolUse hook; git's pre-push
  (`scripts/git-hooks/refuse-history-rewrite`) refuses the push itself in every checkout through a
  machine-wide `core.hooksPath` whose dispatcher still runs each repository's own hooks; and this
  repository's `.githooks/pre-push` runs the same check because its own hooks path overrides the
  machine's. `install-codex-stop-hook.sh` installs the managed layers and the system git hooks
  (remote-box's deploy; the Mac's password step), and `install-mac.sh` installs the git hooks for
  the Mac user on every unattended update. GitHub ruleset `23901100` also refuses rewriting or
  deleting this repository's main. Source: a session amended a pushed commit and force-pushed it
  on 2026-09-23, and nine deployments chased the vanished commit; Tejas: "Why are we like, you
  know, force pushing … add changes and just, like, not remove changes."
  The same pre-command hook, when it refuses nothing, names a website's runbook to an agent about
  to open that site in a browser (`agent-browser open|goto|navigate`, or an MCP navigate call):
  `bot/src/site-runbook-notice.ts` asks the `website-runbooks` skill's `site-runbook --json`
  lookup and returns its answer as `additionalContext`, once per domain per provider session,
  skipping local hosts and his own apps, never blocking, silent when the lookup is missing.
  Built 2026-10-06 for the website-runbooks work (Inbox capture `7b0dae00`).
- **Provenance, not prisons.** What an agent writes shows as the agent's; what Tejas says shows as
  his, with the door it came through ("You · iPhone Action Button", "You · web", `doorOf` in
  `session-message-author.ts`). Agents keep full control of both machines, including repairing,
  restarting or bypassing Concierge and starting agents outside it; nothing checks their commands
  or locks files (Tejas, 2026-09-23: "stop treating this as a maximum security prison"), except
  the refusal to rewrite pushed history he asked for the same evening (the bullet above), and the
  refusal to read the Mac's Messages or Notification Center databases directly or photograph the
  Messages app [decision: codes-hidden-only-for-money-and-identity]: the same pre-command hook refuses any call
  naming them (`messages-database-policy.ts`; even in a commit or session message, so such words go
  in a file passed with `-F` or `--text-file`), and agents read his texts with `router-actions.sh messages`
  (`bot/scripts/messages-read.ts`, Mac only). Texts that look like codes, resets or sign-in links
  (`text-code-withholding.ts`) are shown or hidden by thnkr.ing's one rule, asked over `ssh
  remote-box` (`POST /codes/decide`): ordinary sites and his allow list shown, money and identity and
  his hide list hidden, everything hidden when thnkr.ing cannot be asked. Refusals and
  code reads are logged to `diagnostics/messages-reads.jsonl` in the state directory, never
  with message words. It matches places, not intent, so a command that builds the path at runtime
  a screenshot by window number, or a whole-screen capture gets through; only removing the Mac agents' Full Disk Access and screen
  recording closes that, and that is his open decision
  (`docs/security/2026-10-07-agent-security-review.md`; `docs/runbooks/ROUTER-ACTIONS.md`). His
  doors (thnkr.ing sign-in, device keys, the capture drop-off, the owner socket's human routes)
  record the sender as him, so an agent tests a delivery path through its own entrance,
  `router-actions.sh test-capture` (`bot/scripts/agent-test-capture.ts`): the real pipeline, with
  the agent's accepted input and run carried as `X-Concierge-Agent-Source` or `agentSource`, and
  the owner records it as that agent (`agentTestSource` in `session-owner.ts`), shown in the Inbox
  and starting no Inbox turn. Anything that still reached him as his gets an additive author
  correction (`session_input_author_corrections`). His Slack user token is revoked. When a key file
  changes, `bot/scripts/key-change-notice.ts` (remote-box units) tells him which keys, which agents
  were working and that it takes effect at the next restart; it blocks nothing. Ask him before
  changing what keeps him signed in: the 2026-09-23 sign-out was an agent deciding a sign-out was
  cheap ([incident](docs/incidents/2026-09-23-signed-out-without-asking.md)). See
  [agent test deliveries](docs/runbooks/THINKERING-CAPTURE.md#agent-test-deliveries).
- Keep credentials and private dialogue out of logs, prompts for unrelated work, and
  public artifacts. Preserve the existing authenticated surface and capability boundary.

## Authorities

[Documentation index](docs/README.md) links current ownership, contracts and historical
records. A second instance on Tejas's Mac is a peer: same runtime, own ledger, reached
over Tailscale; `sessions ask --peer` carries requests between ledgers. See
[peer instances](docs/runbooks/PEER-INSTANCES.md). Start with [session owner](docs/architecture/SESSION-OWNER.md),
[the shared wire contract](docs/contracts/session-owner-v1.md),
[the convergence document](docs/plans/2026-09-15-unified-session-convergence.md), and
[deployment](docs/runbooks/DEPLOYMENT.md). Source and focused behavioral tests define
executable details; do not duplicate constants or invent another authority.

Update the relevant current-state document in the same commit when behavior or ownership
changes. Keep `CLAUDE.md -> AGENTS.md` as the same-directory symlink.

Ledger calls are observed at the shared database boundary (`storage-observation.ts`), with
operation-local counts, duration, returned rows and value bytes; see
[storage observation](docs/architecture/STORAGE-OBSERVATION.md). Keep the wrapper when adding
readers so new pages retain query-cost evidence without logging SQL parameters or content.
Ledger mutation results, including standalone writers, pass through `ledger-write-results.ts`
so exact-one claims count only direct rows, never presentation-trigger writes; the same storage
document owns this contract and the release lint checks direct writable canonical-ledger openings.

When `owner_event_loop_lag` says the owner is held,
`kill -URG <MainPID>` writes a 20-second JavaScript CPU profile with stacks to
`$CONCIERGE_STATE_DIR/diagnostics/` (`owner-cpu-profile.ts`), but only when the service runs with
`CONCIERGE_OWNER_CPU_PROFILE=1`: on 2026-10-07 starting it froze the owner 20–40 s each time and
preceded 40 GB runaways, so it is refused by default. `owner_memory` logs the owner's memory each
minute without walking the heap under pressure. Allocation diagnostics need isolated overhead validation before use; RSS is process attribution, not an allocator diagnosis. Never cap Concierge's memory: Tejas rejected ceilings outright
(2026-10-07) and wants the cause found and fixed. **Health notices go to the repair agent, not to him**
[decision: repair-agent-before-tejas]: a crash or stop (systemd failure hooks), a freeze
(`owner-responsiveness.ts`: a minute of freezing in five, or one freeze of 30 s), work not moving
(`stuck-work-watch.ts`) and a dependency that stopped retrying are recorded by kind in `repair_notices`
(`repair-notices.ts`, branched inside `publishProviderFreeNotice`) and handed once a minute to one
standing "Repair agent" session, which works them per [the repair agent runbook](docs/runbooks/REPAIR-AGENT.md)
and reaches him only by declaring needs_you. A total hang or a stopped service is caught by the work-flow
supervisor in remote-box, outside Concierge, which kills or restarts it, starts its own investigator,
hands the report to the repair agent, and pages him through Thinkering's own socket only when Concierge
stays down after that or the investigator says only he can fix it. Usage, key-change and project set-up
notices still go to his Inbox. Each repair has one owner; the table is in remote-box README's work-flow
supervisor section. Name the code path before

changing anything. Loops over ledger rows use `ledgerRows()`, never a statement's `iterate()`: an
early exit left the read open and two crashes followed (2026-10-07; the release lint refuses it). The
ledger has no planner statistics, so a new index can hijack unrelated queries that sort by its
columns: make new indexes partial or narrow, and time the hot reads (history projections, the
Inbox rows) on a copy before shipping.

Startup wait boundaries emit `concierge_startup_phase` with `started`, `completed`, or
`failed`. An unmatched start identifies an unfinished dependency, not a healthy runtime;
the deployment online marker remains the readiness authority. See the deployment runbook.

Release promotion and repair ownership claims acquire SQLite's writer lock before reading
their guards. Keep these transactions immediate: runtime writers remain active after
admission reopens, so deferred read-to-write upgrades can fail despite the busy timeout.
The same writer-first boundary applies to every deployment-domain transaction,
including dead-owner recovery and explicit controller reservations. An application
commit does not change immutable LKG control until proven promotion; use the
[controller recovery procedure](docs/runbooks/DEPLOYMENT.md) for observed control
failures, and never enroll its detached owner alongside an active normal runner.

Provider exhaustion and early top-up/reset invalidation use the shared
[usage cache](docs/architecture/PROVIDER-USAGE.md). After an explicit operator reset,
use its clear command for the affected provider; never bypass a known usage limit merely
to force another attempt. Clear does not authorize replay or resume stopped work.
The separate [usage breakdown](docs/architecture/PROVIDER-USAGE.md#who-used-the-allowance)
reads provider transcripts off the owner event loop and stores its cursor outside the ledger.

## Response contract

Final responses through Concierge start with `TL;DR:`. State the cumulative delivered
outcome concisely, distinguishing committed/integrated work from actual activation and
known limitations. Concierge owns the final provider-reported model/cwd footer.

- Durable intake may cancel a human action before import through the exact-session action-cancel route; the ledger tombstone prevents later dispatch without inventing a target operation. See [owner contract](docs/contracts/session-owner-v1.md). Isolated responsiveness acceptance checks use `CONCIERGE_TEST_AUTHORIZATION=responsive-system-b1eed622`, authorized by the Oct 7 investigation and Oct 8 implementation request; test preload and the production-path refusal remain mandatory. The [loaded acceptance harness](docs/architecture/RESPONSIVE-LOADED-ACCEPTANCE.md) includes an optional whole-App browser/proxy journey across a real owner kill, offline reopen, exact-message notification and provider-wire acknowledgement; it reports synthetic admission, history and authentication boundaries explicitly.
- Human command intake keeps ordered custody even for an invalid route; preparation refusals release the slot, while uncertain owner delivery stops bounded retries without claiming refusal and files a repair notice. Retry keeps the original action identity. See [human command intake](docs/architecture/HUMAN-COMMAND-INTAKE.md).
- Prepared topic read models share attention predicates with the canonical owner and keep large exact values behind digest-addressed chunks; lifecycle and remaining integration requirements are in [prepared topics](docs/architecture/PREPARED-TOPICS.md). The worker's numeric observations distinguish completed batch or committed checkpoint progress from idle passes, lease heartbeat and repeated failures; remote-box routes preparation degradation through the existing external incident.
