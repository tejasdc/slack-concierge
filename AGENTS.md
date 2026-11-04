# Concierge agent guide

Concierge owns the durable sessions, inputs, requests and operations shared by the
server and Mac. thnkr.ing is the authenticated product surface and capability host.
This is a personal, single-operator system. Start with the
[documentation index](docs/README.md), [session ownership](docs/architecture/SESSION-OWNER.md),
and [wire contract](docs/contracts/session-owner-v1.md). Source and focused checks
are authoritative for executable details. The
[former full guide](docs/archive/2026-11-03-pre-index-agent-guide.md) retains exact
wording and Tejas's quoted reasons as dated evidence, not current operating authority.

## Work and delivery

- Tejas deprecated Slack as a product surface on September 15, 2026 (inputs
  `1789490232.840229` and `1789490293.092859`). Do not build Slack features,
  preserve Slack parity, run Slack-specific tests or sandboxes, or treat historical
  Slack review requirements as current gates. Preserve accepted history and state.
  The [capture](docs/runbooks/THINKERING-CAPTURE.md) and
  [native Inbox](docs/contracts/native-inbox.md) contracts own Thinkering delivery.
- Implement a requested change as one whole through the normal Git and
  [deployment path](docs/runbooks/DEPLOYMENT.md). Use an isolated task worktree
  when writers may overlap. Never hand-edit an installed release or host-owned
  service configuration in this repository. Check the installed behavior through
  the agent's own marked entrance before calling it done
  [decision: agents-check-real-end-to-end-behavior]. The
  [agent test delivery](docs/runbooks/THINKERING-CAPTURE.md#agent-test-deliveries)
  is for capture paths; use a feature's own socket or route when appropriate.
- Every commit carries an `Update-note:` sentence in product language and a
  `Failure-record:` trailer naming its replayable failure record or `none`.
  The [update-note rule](docs/runbooks/DEPLOYMENT.md#update-notes-for-every-commit) and
  [failure record guide](docs/incidents/README.md) own the formats. A pushed
  commit is not an installed release. Pushed history is never rewritten; the
  [deployment runbook](docs/runbooks/DEPLOYMENT.md) records the enforced path.
- Protected agent code launches hide the live ledger and its disk image while allowing Thinkering's
  phone-width release check to mount its read-only data view. The
  [deployment runbook](docs/runbooks/DEPLOYMENT.md) owns the isolation contract.
- Keep credentials and private dialogue out of unrelated prompts, logs and public
  artifacts. Preserve the authenticated data and capability boundaries in
  [session ownership](docs/architecture/SESSION-OWNER.md) and
  [agent security](docs/security/2026-10-07-agent-security-review.md).

## Session and Inbox obligations

- Route agent issue reports through `router-actions.sh report`, which opens the
  Inbox thread and request before routing. See
  [agent issue reports](docs/contracts/native-inbox.md#agent-issue-reports).
  Do not edit the Inbox router's standing instructions here; ask its bound
  session to change them. See [router actions](docs/runbooks/ROUTER-ACTIONS.md).
- A request closes through an explicit reply command, never an agent's prose or
  silence. Follow the per-run `REQUEST_PROTOCOL` and `sessions --help`; they
  carry the live syntax and enforcement. The [request and return contract](docs/architecture/SESSION-OWNER.md#requests-and-returns)
  and [prompt thread answers](docs/architecture/PROMPT-THREAD-ANSWERS.md)
  own return position, partial answers and final disposition.
- Preserve exact accepted input, run, action, source-message and target identity.
  Do not replay ambiguous or acknowledged effects. Keep human authorship distinct
  from agent and service inputs. The [session owner wire contract](docs/contracts/session-owner-v1.md),
  [human command custody](docs/architecture/HUMAN-COMMAND-INTAKE.md), and
  [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md) own those boundaries.
- The canonical owner, not agent memory, enforces Inbox placement, attention and
  delivery. Unfiled human inputs prevent the Inbox router from ending its turn.
  See [filing before stopping](docs/contracts/native-inbox.md#filing-before-stopping),
  [routing handoffs](docs/contracts/native-inbox.md#routing-handoffs-on-the-source-message),
  [human questions](docs/architecture/HUMAN-QUESTIONS.md), and
  [requested phone delivery](docs/contracts/requested-phone-notifications.md).

## Find the authority

| Work | Current authority |
| --- | --- |
| Sessions, queues, steering, Stop, peer handoff and recovery | [Session owner](docs/architecture/SESSION-OWNER.md), [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md), [wire contract](docs/contracts/session-owner-v1.md) |
| Inbox topics, routing, areas, thread replies and attention | [Native Inbox](docs/contracts/native-inbox.md), [areas](docs/architecture/AREAS-OF-INTEREST.md), [prompt answers](docs/architecture/PROMPT-THREAD-ANSWERS.md), [prepared topics](docs/architecture/PREPARED-TOPICS.md) |
| Provider binding, accounts, usage, fresh Claude commands from agent shells, history and external workers | [Provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md), [provider sessions](docs/architecture/PROVIDER-SESSIONS.md), [usage](docs/architecture/PROVIDER-USAGE.md), [history index](docs/architecture/PROVIDER-HISTORY-INDEX.md), [execution host](docs/architecture/EXECUTION-HOST.md) |
| Provider sign-in renewal through the Mac's saved browser account | [Sign-in approval](docs/runbooks/CLAUDE-SIGNIN-APPROVAL.md), [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md) |
| Shared Codex App Server lifecycle and session observation | [Codex App Server](docs/runbooks/CODEX-APP-SERVER.md), [external Codex turns](docs/architecture/SESSION-OWNER.md#externally-submitted-codex-turns) |
| Bounded reads, SQLite ledger durability and diagnostic snapshots | [Storage observation](docs/architecture/STORAGE-OBSERVATION.md), [ledger durability](docs/architecture/LEDGER-DURABILITY.md), [native read execution](docs/architecture/NATIVE-READ-EXECUTION.md), [diagnostic snapshot](docs/runbooks/DIAGNOSTIC-SQLITE-SNAPSHOT.md) |
| Releases, autonomous repair, host alerts and Mac installation | [Deployment](docs/runbooks/DEPLOYMENT.md), [repair architecture](docs/architecture/DEPLOYMENT-REPAIR.md), [repair agent](docs/runbooks/REPAIR-AGENT.md), [Grafana alerts](docs/runbooks/GRAFANA-ALERTS.md), [peer instances](docs/runbooks/PEER-INSTANCES.md) |
| Project, session, Inbox and saved-work commands | [Router actions](docs/runbooks/ROUTER-ACTIONS.md), [saved work](docs/plans/2026-09-23-saved-work-scheduled-and-banked.md) |
| Canvas project binding and current board title beside stable project folders | [Router actions](docs/runbooks/ROUTER-ACTIONS.md), [wire contract](docs/contracts/session-owner-v1.md#peer-instances) |
| Mac and server Lab reads and writes | [Router actions](docs/runbooks/ROUTER-ACTIONS.md#discussing-in-the-lab); the server holds the Lab key and the peer channel carries Mac calls under their own source identity |
| Captures, audio, speech and Canvas observations | [Capture ingress](docs/architecture/CAPTURE-INGRESS.md), [Thinkering capture](docs/runbooks/THINKERING-CAPTURE.md), [speech](docs/architecture/SPEECH-FALLBACK-JOBS.md), [Canvas think-aloud](docs/architecture/canvas-think-aloud.md) |
| Current-versus-historical documentation | [Documentation index](docs/README.md); plans and incidents are evidence, not authority for current behavior |

Update the relevant current-state document in the same commit when behavior or
ownership changes. Keep `CLAUDE.md -> AGENTS.md` as the same-directory symlink.
Final responses through Concierge start with `TL;DR:`, distinguish committed
work from installed and observed behavior, and leave the provider-reported
model and working-folder footer to Concierge.
