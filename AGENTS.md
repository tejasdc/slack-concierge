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
- Tejas's later request `1789493856.395309` explicitly retains Thinkering bug reports in
  the Concierge DM for agent routing, including complete text and screenshots. The
  [capture contract](docs/runbooks/THINKERING-CAPTURE.md) owns this narrow exception;
  keep accepted destinations and retries immutable. The no-test delivery policy applies.
- Input `1789496623.399079` requires discovery and addressed communication for top-level
  Thinkering sessions from both native and existing Slack callers. Both use the common
  session owner; provider subagents are outside scope. That input authorizes completing
  the real blocked Releases/update-banner coordination as end-to-end evidence, without
  automated tests, sandbox runs or review cycles.

## Working boundaries

- One catalogue and accepting owner: canonical sessions, inputs, operations and correlated
  requests live in Concierge's existing ledger. Thinkering is an authenticated consumer
  and capability host, not another queue, dispatcher or session authority.
- Session names use the canonical metadata `title` shown in Thinkering. Router
  `--session-name` initializes that field; do not add a separate display label or
  infer names inside Concierge from task prose. See the shared wire contract.
- Native session/input identity is independent of Slack. Never fabricate a Slack message,
  channel, timestamp or provider binding to satisfy an obsolete caller shape.
- Codex Remote mirroring handles inputs actually submitted by another Codex client.
  Match native provider input IDs against the common ledger and exact provider turn;
  human, agent and service inputs owned by Concierge must not be labeled Remote or
  exported through that observer. Native results belong in Thinkering and correlated
  request replies; an old Slack thread binding alone does not authorize mirroring them.
- Serialize execution through the existing per-session FIFO and provider owner. Keep
  preparation, request/return obligations, native Stop and recovery with their existing
  authorities. No arbitrary communication quota or reciprocal automatic request loop.
- Persist accepted intent before external effects. Retain exact action/input/run identity,
  verify current ownership, and preserve uncertain outcomes. Never replay completed work
  or resend an ambiguous provider effect merely because a response was lost.
- Keep attention, read/dismiss and outcome separate. Project actionable failures once;
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

Provider exhaustion and early top-up/reset invalidation use the shared
[usage cache](docs/architecture/PROVIDER-USAGE.md). After an explicit operator reset,
use its clear command for the affected provider; never bypass a known usage limit merely
to force another attempt. Clear does not authorize replay or resume stopped work.

## Response contract

Final responses through Concierge start with `TL;DR:`. State the cumulative delivered
outcome concisely, distinguishing committed/integrated work from actual activation and
known limitations. Concierge owns the final provider-reported model/cwd footer.
