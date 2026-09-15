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

- One catalogue and accepting owner: canonical sessions, inputs, operations and correlated
  requests live in Concierge's existing ledger. Thinkering is an authenticated consumer
  and capability host, not another queue, dispatcher or session authority.
- Native discovery remains available when historical Slack routing evidence is unavailable.
  Report that source failure in search coverage and omissions; do not let a retired
  channel binding hide canonical sessions or claim complete historical coverage.
- Session names use the canonical metadata `title` shown in Thinkering. Router
  `--session-name` initializes that field; do not add a separate display label or
  infer names inside Concierge from task prose. See the shared wire contract.
- Native session/input identity is independent of Slack. Never fabricate a Slack message,
  channel, timestamp or provider binding to satisfy an obsolete caller shape.
- Retained DM and native agents route through `router-actions.sh sessions`: discover
  exact addresses or create a named new session with the requested alias/effort and
  registered project. The owner pins model, effort and cwd before dispatch. Preserve
  complete diagnostics/images in attachment custody, and respect explicit NEW requests.
  See [router helper](docs/runbooks/ROUTER-ACTIONS.md); no channel restoration or post.
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
- A native partial reply preserves its final return obligation across successful provider
  turn completion. A later live input in the exact recipient session can finish it.
  Existing request deadlines provide a durable one-time overdue native wake; partial
  updates do not reset them. Never claim a future completion handoff from a final reply.
- Persist accepted intent before external effects. Retain exact action/input/run identity,
  verify current ownership, and preserve uncertain outcomes. Never replay completed work
  or resend an ambiguous provider effect merely because a response was lost.
- Keep unread activity, explicit-mention attention, read/dismiss and outcome separate.
  Ordinary responses and failures do not set Needs attention. Project their activity once;
  stale observations cannot hide later work or recreate dismissed notifications.
- Source history is cited evidence. Verify exact source/version/branch/event membership.
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

Provider exhaustion and early top-up/reset invalidation use the shared
[usage cache](docs/architecture/PROVIDER-USAGE.md). After an explicit operator reset,
use its clear command for the affected provider; never bypass a known usage limit merely
to force another attempt. Clear does not authorize replay or resume stopped work.

## Response contract

Final responses through Concierge start with `TL;DR:`. State the cumulative delivered
outcome concisely, distinguishing committed/integrated work from actual activation and
known limitations. Concierge owns the final provider-reported model/cwd footer.
