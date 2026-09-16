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
- Retained audio attachments keep their original bytes and an optional Whisper transcript
  in the same attachment row. The authenticated human surface can request transcription
  of a retained audio ID before sending; retry reuses the retained text. Provider dispatch
  uses that text and avoids repeating it when it is already in the accepted human message.
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
  effort at creation. An admitted agent may set only its own still-empty title
  through `sessions title` with its exact source input/run and stable action ID;
  explicit creation titles and human renames take precedence.
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
- Tejas's report `a3601736-3f14-4659-80a0-583d13a3e68b` on September 16, 2026 moved the
  default provider to Opus after Codex credits ran out on a second account. One
  authority owns it: `DEFAULT_PROVIDER_ALIAS` in `bot/src/aliases.ts`, resolved through
  `configuredProviderDefault()` wherever a stored project/channel default is read. A
  project that selected its own provider keeps that selection, an explicit human
  provider/model/effort choice wins, and a running session keeps its binding. Do not add
  a fallback chain or automatic provider switching. An Opus session uses its own
  discretion to hand bounded work to `cx-sol` for well-scoped implementation and to
  `cx-terra`/`cx-luna` for mechanical edits, verification and test runs, and reviews what
  comes back rather than shipping it unread. See
  [provider sessions](docs/architecture/PROVIDER-SESSIONS.md).
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
- A native partial reply preserves its final return obligation across successful provider
  turn completion. A later live input in the exact recipient session can finish it.
  Existing request deadlines provide a durable one-time overdue native wake; partial
  updates do not reset them. Never claim a future completion handoff from a final reply.
- A dedicated acknowledged request turn with one question and no steering can settle
  from its exact retained final text when an explicit reply is unconfirmed. Duplicate
  reply actions can be inspected after the run ends. An unanswered prerequisite holds
  its dependent request for a decision; it does not prove the prerequisite failed.
- Final work replies declare `completed`, `failed`, or `needs_decision`. Declared
  completion waits for that exact provider run to finish successfully before its
  return is retained without waking the requester. Failed, decision-needed, unknown
  and unconfirmed outcomes still return. An unclassified work answer is
  `undetermined` and holds dependents. Never infer success from `requestedEffect`.
- Persist accepted intent before external effects. Retain exact action/input/run identity,
  verify current ownership, and preserve uncertain outcomes. Never replay completed work
  or resend an ambiguous provider effect merely because a response was lost.
- Session views and message metadata expose exact retained turn timing (start/end, provider acknowledgement and reported work duration). Missing historical duration stays unknown. Claude print-mode tool results retain error status and provider timestamps for the same operation display as Codex.
- A selected-message reply is an immutable human input carrying `replyToMessage:{kind:"message",sessionId,messageId,source?}`. Its session ID must equal the addressed canonical session; imported-source targets retain their source/version/event pin. It is presentation/provenance for the provider envelope, not an agent/service reply or a substitute for the existing `replyTo` request-return field.
- Codex lifecycle observation includes turns submitted by other authorized clients.
  Provider observation never creates an owner input/run or overwrites its terminal receipt;
  see [external lifecycle](docs/architecture/SESSION-OWNER.md#externally-submitted-codex-turns).
- Keep unread activity, explicit-mention attention, read/dismiss and outcome separate.
  Ordinary responses and failures do not set Needs attention. Project their activity once;
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
  transport, not chat content or authority. SDK interruption controls are not messages.
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
- Concierge delivery ends at the normal push to `origin/main`. End the provider turn so
  the existing detached worker can reach an idle boundary. Do not manually restart the
  service, wait for its deployment, add a deployment waiter, or restart the shared Codex
  App Server. The established deployment/repair owner handles rollout and health.
  Human input `1789510460.238219` explicitly authorizes the bounded native Inbox recovery
  exception: `bot/scripts/native-pipeline-continuation.ts` enrolls the current live source
  before yielding; remote-box's single safeguard observes deployment readiness/deadline
  and admits one service continuation through the existing native queue. It never
  deploys or runs a provider. Stop/pause/archive cancel it. See the native Inbox contract.
- A wiped deployment registry must not be repaired by restoring the entire SQLite backup,
  replaying an interrupted run, or fabricating its missing incident/review result. The
  exceptional operator recovery in [the deployment runbook](docs/runbooks/DEPLOYMENT.md)
  verifies a proven backup LKG and reserves the control handoff in one transaction before
  admitting desired-state work; its human-policy exception is distinct from `SHIP`.
- Keep credentials and private dialogue out of logs, prompts for unrelated work, and
  public artifacts. Preserve the existing authenticated surface and capability boundary.

## Authorities

[Documentation index](docs/README.md) links current ownership, contracts and historical
records. Start with [session owner](docs/architecture/SESSION-OWNER.md),
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
