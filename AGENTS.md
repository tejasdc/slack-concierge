# Concierge agent guide

Concierge is the shared session and request owner behind Thinkering. It is a personal,
single-operator application. Thinkering is the product surface and Tejas's real use is the
acceptance feedback.

## Current delivery policy

Tejas deprecated Slack in inputs `1789490232.840229` and `1789490293.092859` on
September 15, 2026. This supersedes the former Slack sandbox, feature-parity, full-gate
and mandatory review requirements in this repository and linked historical material.

- Do not build Slack features, preserve Slack feature parity, run Slack-specific tests,
  claim Slack sandbox lanes, or perform Slack click testing.
- Implement requested Thinkering behavior promptly. Use the existing evidence only. Tejas's final instruction1789490492.818709 forbids ALL agent-run
  tests, including focused tests. Do not run, add or bypass test/verification commands.
  Tejas owns end-to-end testing and will report failures.
  This includes autonomous deployment repair. Model children do not inherit writable
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
- Retained audio attachments keep their original bytes and an optional transcript
  in the same attachment row. The authenticated human surface can request transcription
  of a retained audio ID before sending; retry reuses the retained text. Provider dispatch
  uses that text and avoids repeating it when it is already in the accepted human message.
  A forwarded recording is a new custody copy of identical bytes, so it reuses the words its
  original already has (found by `sha256`) instead of being transcribed again.
- Speech-to-text is one engine process per host behind one line protocol
  (`bot/src/speech-engine.ts`), chosen by platform. The Mac's Apple engine (~21 MB) loads at
  startup and stays; the box's Parakeet (~1 GB) loads on the first dictation and is released
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
  September 21, 2026: the fallback is the owner path). Transcriptions still run one at a time through the lane in
  `transcription.ts`; `audio_transcribed` names the engine (and the peer) and never text.
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
- Executable input receipts expose `statusDetail` with a human reason, known condition
  clearance time and whether that exact input retries automatically. Terminal failures
  remain immutable history; queued inputs behind parked heads remain owed work until
  their owner reconciles the head. See the shared wire contract.
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
  reply, and the echo merges into it under the same identity. Do not build a
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
- **A request closes only through a command, never through prose.** How agents must reply is
  written for them once, in `REQUEST_PROTOCOL` (`bot/src/request-protocol.ts`), rendered into the
  per-turn instructions and `sessions --help`; request preambles, reminders and every doc point
  at it. Change the wording there and nowhere else. The mechanism, its grounding (FIPA Request,
  transactional outbox), the enforcement table and the measurements are in
  [the request reply protocol](docs/plans/2026-09-23-request-reply-protocol.md). For engineers
  here: nothing in the owner may settle a request from a turn's text or silence (only ChatGPT
  and consultation-only turns, which have no reply command, answer with their turn);
  `request-liveness.ts` owns the stranded check, the one reminder and the stalled notice, and
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
  to a request that sent its own partial never settle it. Each sibling settled that way
  returns its own result.
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
  Every settled request with a requester input produces exactly one `return:<eventId>`
  input, including confirmed completion, even while the requester is mid-run; only a
  paused, archived or missing requester holds it. Completion used to be retained
  without a return, and the Inbox silently lost 64 finished results on September 21,
  2026, so never reintroduce a settled-but-unreturned state. `session-return-audit.ts`
  logs `session_return_undelivered` (error) once for any settled result still
  unreturned after ten minutes. Legacy `retained` rows stay as history; the Inbox's
  rows from that day were re-delivered once in one digest reply, and rows the old runtime
  retained during rollout, or held waiting for their run to end, are released to return
  at startup. An
  unclassified work answer is `undetermined` and holds dependents. Never infer
  success from `requestedEffect`.
- Persist accepted intent before external effects. Retain exact action/input/run identity,
  verify current ownership, and preserve uncertain outcomes. Never replay completed work
  or resend an ambiguous provider effect merely because a response was lost.
- Every attributable message carries the accepted input it belongs to as `inputId`, so a
  client threads a request to its replies from owner-established identity rather than
  page order; `submissionId` keeps its provider-submission meaning. Any owner read a
  client repeats is bounded by the owner: event reads take `kind`/`runId` sets and a
  `limit`, a client holding every receipt asks `changedAfter=<asOf>` and gets back only
  those still able to change plus new ones — decided from whether each receipt has
  settled for good, never from which events fired, since a hand-off's answer records no
  event on it — and receipt reads page, so unread state and Inbox receipts cost a page instead
  of the whole ledger. A client holding a page asks `history?after=<asOf>` for what
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
  Ordinary responses and failures do not set Needs attention. Every working turn ends its
  answer with one exact `[[outcome-k7q4:…]]` marker line (`turn-outcome-marker.ts`):
  done, response, needs_you with the question, or failed with why. Tejas rejected the
  provider-enforced form (it doubled Claude turns and one schema rule failed every Claude
  turn) and chose this single line. Only needs_you and response (an answer he must
  read, not routine replies), or a hand-off reply's
  `needs_decision`, raises attention, cleared by his reply, a later declaration or
  dismiss, never by reading. In the Inbox that attention is a question record in its
  topic, with a kind (decision or reading), an owner and an explicit recorded end; a
  marker the run did not declare as a question is held unfiled until the router files it,
  never guessed into a thread ([design](docs/plans/2026-09-23-attention-that-ends.md),
  [contract](docs/contracts/native-inbox.md#topics)). The marker is stripped before display; a turn without one is
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
  changed or unavailable candidates remain explicit coverage omissions.
- Source history is cited evidence. Verify exact source/version/branch/event membership.
  Catalogue projections distinguish unbound imported `historical-evidence` from
  conversations; discovery never promotes evidence into active work. Reconstructed
  consultations and explicitly bound imports remain conversations. The wire contract
  owns the classification and backward-compatible surface rule.
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
- A commit that changes what Tejas sees or can do carries an `Update-note:` line — one
  sentence in product language about his experience, addressed to him, no code terms. Say the
  consequence when waiting has one ("until this lands, questions you cannot answer still count
  as waiting on you"), because that is the only honest way he can tell an urgent update from a
  routine one: no severity is derived anywhere, and a label nothing populates would be worse
  than none (his question, 2026-09-22: "I can't tell how important it is for us to install
  that"). Or use
  `Update-note: internal` when he would notice nothing. thnkr.ing shows those sentences,
  and only those, while a Concierge update waits for his sessions to finish, so he knows
  what is about to be applied; commit subjects are never shown to him. A note can be added
  to an already-pushed commit with `git notes --ref=refs/notes/update add -m "<sentence>"
  <commit>` followed by `git push origin refs/notes/update`, and that note wins.
  `release-history.ts` reads them, never remembering one, so a note written or corrected while
  an update waits reaches him on the next read; the wait payload carries them. **Write the note
  when you commit.** The `post-commit` hook says so, to you, while you are still there; it warns
  and never refuses, because a missing sentence must not stop a fix from shipping (Tejas,
  2026-09-22). Release time is too late to start: the release asked the authoring session, and
  on 2026-09-22 that ask sat in the queue of a session whose running work was itself blocking the
  release, so he was shown a waiting update and nothing about it, twice in one evening (captures
  `d0781019`, `d5881417`). That mechanism is removed. An update with no notes says nothing to him
  rather than announcing that nobody wrote one — so an unwritten note is invisible to everyone
  except him, waiting on an update he cannot see into. A note pushed from another machine is not
  readable here until `refs/notes/update` is fetched into this checkout.
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
  subscriptions, which is why this restart must not be done over SSH. This does not permit
  an agent to restart the App Server for any other reason.
  That surface covers every instance, not only the one serving the page: the auth routes
  take a `machine`, and a call for the peer is forwarded over the existing peer channel to
  the peer's identical route, where its own Concierge runs the login. Neither instance ever
  writes the other's credentials, and a machine that is not answering is shown as such
  beside the one that is rather than hidden. See [peer instances](docs/runbooks/PEER-INSTANCES.md).
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
  switches, keeps or snapshots an account.
- A kept account's name is recorded beside it, never inferred from whoever is signed in.
  A Codex credential names its own account; a Claude one carries no address at all, so the
  code that labelled it read `~/.claude.json`, which is the global record of the *current*
  sign-in. Every kept Claude account therefore wore the current account's email: his
  personal account sat in the list as `tejas@chann.app`, which read as one account listed
  twice and would have switched him to the wrong one (2026-09-22). `saveProfile` writes
  `<id>.email` beside the credential, and whether an account is the one in use is decided by
  that address — a refresh token rotates and its fingerprint stops matching, which would
  list the account in use a second time. An account kept before a name was recorded recovers
  its address by applying `profileId` forward to the addresses this machine already knows
  (the usage reader lists every Claude account by address) and matching — an equality check
  on a function we own, not a guess at a slug. Showing the filed name instead was shipped
  knowingly for one evening and was wrong twice over: a usage reading is keyed by address, so
  the same row also claimed its usage had never been read while that account sat at its
  weekly limit, and he read the screen as broken (2026-09-23).
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
- Work that is about to stop is told before it stops, not after: Tejas once per allowance
  period through the existing notification path, any caller through
  `router-actions.sh sessions usage`, and sessions through their own context. A turn that
  starts while the account is low reads it in its per-turn instructions; a turn already
  running is told inside that run, pinned to that exact live run so a notice about spending
  can never itself start a turn, once per session per period. It informs and asks; it never
  instructs, and a running session keeps its model binding — Tejas settled that on
  2026-09-23 ("we don't have to switch to our cheaper model suddenly"). Delegation should
  cross providers: a session low on one is told where the other has room. Automatic account
  switching is designed but not built, and depends on two unproven things; see
  [the plan](docs/plans/2026-09-23-usage-forecast-and-account-switching.md).
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

## Response contract

Final responses through Concierge start with `TL;DR:`. State the cumulative delivered
outcome concisely, distinguishing committed/integrated work from actual activation and
known limitations. Concierge owns the final provider-reported model/cwd footer.
