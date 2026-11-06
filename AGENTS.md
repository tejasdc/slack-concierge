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
- Concierge service stops during a release go through the deployment controller's
  [attributed systemd stop path](docs/runbooks/DEPLOYMENT.md#runtime-dependencies-and-service-shutdown).
- Capture queue calls cancel on service stop under the existing claim and recovery
  contract; see [capture ingress](docs/architecture/CAPTURE-INGRESS.md).
- Operator-controlled offline releases stop the old owner before candidate activation;
  see the [deployment runbook](docs/runbooks/DEPLOYMENT.md#runtime-dependencies-and-service-shutdown).
- Owner startup timing and deferred history catch-up follow the
  [deployment startup contract](docs/runbooks/DEPLOYMENT.md#owner-startup-and-history-catch-up).
- Candidate schema comparison and its bounded read-only SQLite lock recovery
  follow the [deployment runbook](docs/runbooks/DEPLOYMENT.md#candidate-schema-comparison).
  Its offline migration phase timings and backup boundary are in the same
  [deployment runbook](docs/runbooks/DEPLOYMENT.md#runtime-dependencies-and-service-shutdown).
- A repair-owned deployment run ends its old transient runner without reclaiming the repair;
  see [automatic failure behavior](docs/runbooks/DEPLOYMENT.md#automatic-failure-behavior).
- Every commit carries an `Update-note:` sentence in product language and a
  `Failure-record:` trailer naming its replayable failure record or `none`.
  The [update-note rule](docs/runbooks/DEPLOYMENT.md#update-notes-for-every-commit) and
  [failure record guide](docs/incidents/README.md) own the formats. A pushed
  commit is not an installed release. Pushed history is never rewritten; the
  [deployment runbook](docs/runbooks/DEPLOYMENT.md) records the enforced path.
- Protected agent code launches hide the live ledger and its disk image while allowing Thinkering's
  phone-width release check to mount its read-only data view. The
  [deployment runbook](docs/runbooks/DEPLOYMENT.md) owns the isolation contract.
- Background command watches have Concierge ownership and deadlines; completed Codex turns
  flag surviving server processes outside their owned execution unit by exact run identity
  through an Inbox agent report.
  See [execution host](docs/architecture/EXECUTION-HOST.md#agent-browser-process-ownership)
  and [durable watches](docs/architecture/WATCHES.md).
- Project creation validates organizer placement in the owner ledger and performs scaffold and
  GitHub work as a replay-safe job on the configured project runner. See [runners](docs/architecture/RUNNERS.md).
- Hosted run adoption and parked-run recovery follow the
  [execution host](docs/architecture/EXECUTION-HOST.md) contract; never reset their ledger status by hand.
- Outside Codex repair sessions use a one-input command line and take follow-ups
  in the next turn; see [router actions](docs/runbooks/ROUTER-ACTIONS.md#outside-requests).
- Keep credentials and private dialogue out of unrelated prompts, logs and public
  artifacts. Preserve the authenticated data and capability boundaries in
  [session ownership](docs/architecture/SESSION-OWNER.md) and
  [agent security](docs/security/2026-10-07-agent-security-review.md).
- Fresh agent-started Claude Code commands skip older Concierge wrappers in PATH and tolerate the package install's brief
  missing-command window before account selection; see the
  [provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md#claude-code-started-by-an-agent).
- Shared Codex turn recovery and its exact identity boundary follow
  [provider sessions](docs/architecture/PROVIDER-SESSIONS.md#codex-provider-turn-reconciliation).
- Agent-started top-model choices and helper defaults follow [provider sessions](docs/architecture/PROVIDER-SESSIONS.md#delegation-and-escalation);
  model and helper call shares are in [usage](docs/architecture/PROVIDER-USAGE.md#who-used-the-allowance).

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
- Held final returns retry delivery to their asker while completed Inbox answer
  upkeep is retained once per exact event; the yielding open-thread sweep is
  described in [native Inbox](docs/contracts/native-inbox.md#owner-upkeep-under-held-returns).
- ChatGPT questions carry an exact task and remain open through failed attempts,
  return receipt, and explicit answer handling. See [ChatGPT answer obligations](docs/architecture/CHATGPT-ANSWER-OBLIGATIONS.md).
- Preserve exact accepted input, run, action, source-message and target identity.
  Continuation ancestry visits each source input once because valid service inputs
  can point to themselves; see the [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md).
  Do not replay ambiguous or acknowledged effects. Keep human authorship distinct
  from agent and service inputs. The [session owner wire contract](docs/contracts/session-owner-v1.md),
  [human command custody](docs/architecture/HUMAN-COMMAND-INTAKE.md), and
  [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md) own those boundaries.
- Banked phone work that Tejas permits only overnight uses the explicit quiet-only saved-work choice; request cancellation also revokes a queued saved turn. See [session ownership](docs/architecture/SESSION-OWNER.md#one-execution-owner) and [router actions](docs/runbooks/ROUTER-ACTIONS.md#current-native-routing).
- A device question can name an app startup when the physical device has no agent route;
  the agent explains the failed route. Returned `needs_you` questions can be withdrawn
  by exact event identity when they become stale. See [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md)
  and the [session owner contract](docs/contracts/session-owner-v1.md).
- The canonical owner, not agent memory, enforces Inbox placement, attention and
  delivery. Unfiled human inputs prevent the Inbox router from ending its turn.
  Direct human thread replies join the same topic request ledger on admission;
  future-answer posts require recorded work for their exact source or request.
  `sessions topics obligations` shows every open request, its current destination and age.
  Failed, cancelled or stalled agent attempts leave his Inbox request open for
  durable recovery; a routed human work message joins that request ledger atomically,
  and an unverified completion stays open for a check. Checked completion, a live only-he-can question, or
  Tejas's own withdrawal determines what happens next. See
  [native Inbox](docs/contracts/native-inbox.md).
  The router command refuses a native Codex helper's attempt to close or cancel
  its parent session's task; see the [failure record](docs/incidents/2026-11-04-inbox-failed-attempts-closed-human-work.md).
  See [filing before stopping](docs/contracts/native-inbox.md#filing-before-stopping),
  [routing handoffs](docs/contracts/native-inbox.md#routing-handoffs-on-the-source-message),
  [human questions](docs/architecture/HUMAN-QUESTIONS.md), and
  [requested phone delivery](docs/contracts/requested-phone-notifications.md).
- Closing a human Inbox request requires evidence for that exact obligation;
  a shared thread, later message or shared source alone cannot withdraw or
  supersede it. See [native Inbox](docs/contracts/native-inbox.md) and the
  [closure failure record](docs/incidents/2026-11-04-unrelated-evidence-could-close-human-work.md).
- A question linked to an exact to-do is rechecked before Inbox attention and
  question reads; a Done or Dropped to-do settles that question. Its attention
  event carries the to-do ID for thnkr.ing's final notification check. See
  [requested phone notifications](docs/contracts/requested-phone-notifications.md).

## Find the authority

| Work | Current authority |
| --- | --- |
| Sessions, queues, steering, Stop, peer handoff and recovery | [Session owner](docs/architecture/SESSION-OWNER.md), [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md), [wire contract](docs/contracts/session-owner-v1.md) |
| Inbox topics, routing, areas, thread replies, attention and prepared-worker catch-up | [Native Inbox](docs/contracts/native-inbox.md), [areas](docs/architecture/AREAS-OF-INTEREST.md), [prompt answers](docs/architecture/PROMPT-THREAD-ANSWERS.md), [prepared topics](docs/architecture/PREPARED-TOPICS.md) |
| Provider binding, accounts, usage, fresh Claude commands from agent shells, history and external workers | [Provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md), [provider sessions](docs/architecture/PROVIDER-SESSIONS.md), [usage](docs/architecture/PROVIDER-USAGE.md), [history index](docs/architecture/PROVIDER-HISTORY-INDEX.md), [execution host](docs/architecture/EXECUTION-HOST.md) |
| Provider sign-in renewal through the Mac's saved browser account | [Sign-in approval](docs/runbooks/CLAUDE-SIGNIN-APPROVAL.md), [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md) |
| Exact thnkr.ing Mac web-app Computer Use and human authorization | [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md), [peer instances](docs/runbooks/PEER-INSTANCES.md) |
| Shared Codex App Server lifecycle, post-turn process audit and session observation | [Execution host](docs/architecture/EXECUTION-HOST.md), [Codex App Server](docs/runbooks/CODEX-APP-SERVER.md), [external Codex turns](docs/architecture/SESSION-OWNER.md#externally-submitted-codex-turns) |
| Owner on its own app server, agents' network entrance and tokens, runner lease protocol | [Runners](docs/architecture/RUNNERS.md), [execution host](docs/architecture/EXECUTION-HOST.md) |
| Runner reads of report source chains and bounded report windows | [Runners](docs/architecture/RUNNERS.md) |
| Runner-resolved project folders and bounded project file, TODO, worktree, Google and outside-run operations | [Runners](docs/architecture/RUNNERS.md#runner-machine-calls) |
| Provider accounts, sign-in custody and account homes on runners | [Runners](docs/architecture/RUNNERS.md#provider-accounts-on-runners), [provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md) |
| Bounded reads, SQLite ledger durability and diagnostic snapshots | [Storage observation](docs/architecture/STORAGE-OBSERVATION.md), [ledger durability](docs/architecture/LEDGER-DURABILITY.md), [native read execution](docs/architecture/NATIVE-READ-EXECUTION.md), [diagnostic snapshot](docs/runbooks/DIAGNOSTIC-SQLITE-SNAPSHOT.md) |
| Releases, autonomous repair, host alerts and Mac installation | [Deployment](docs/runbooks/DEPLOYMENT.md), [repair architecture](docs/architecture/DEPLOYMENT-REPAIR.md), [repair agent](docs/runbooks/REPAIR-AGENT.md), [Grafana alerts](docs/runbooks/GRAFANA-ALERTS.md), [peer instances](docs/runbooks/PEER-INSTANCES.md) |
| Project, session, Inbox and saved-work commands | [Router actions](docs/runbooks/ROUTER-ACTIONS.md), [saved work](docs/plans/2026-09-23-saved-work-scheduled-and-banked.md) |
| Canvas project binding and current board title beside stable project folders | [Router actions](docs/runbooks/ROUTER-ACTIONS.md), [wire contract](docs/contracts/session-owner-v1.md#peer-instances) |
| Mac and server Lab reads and writes | [Router actions](docs/runbooks/ROUTER-ACTIONS.md#discussing-in-the-lab); the server holds the Lab key and the peer channel carries Mac calls under their own source identity |
| Captures, audio, speech and Canvas observations | [Capture ingress](docs/architecture/CAPTURE-INGRESS.md), [Thinkering capture](docs/runbooks/THINKERING-CAPTURE.md), [speech](docs/architecture/SPEECH-FALLBACK-JOBS.md), [Workers AI speech and search embeddings](docs/architecture/WORKERS-AI.md), [Canvas think-aloud](docs/architecture/canvas-think-aloud.md) |
| Current-versus-historical documentation | [Documentation index](docs/README.md); plans and incidents are evidence, not authority for current behavior |

Update the relevant current-state document in the same commit when behavior or
ownership changes. Keep `CLAUDE.md -> AGENTS.md` as the same-directory symlink.
Final responses through Concierge start with `TL;DR:`, distinguish committed
work from installed and observed behavior, and leave the provider-reported
model and working-folder footer to Concierge.
