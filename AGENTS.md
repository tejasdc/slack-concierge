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
  [sealed deployment path](docs/runbooks/DEPLOYMENT.md). Use an isolated task worktree
  when writers may overlap. Never hand-edit an installed release or host-owned
  service configuration in this repository. Check the installed behavior through
  the agent's own marked entrance before calling it done
  [decision: agents-check-real-end-to-end-behavior]. The
  [agent test delivery](docs/runbooks/THINKERING-CAPTURE.md#agent-test-deliveries)
  is for capture paths; use a feature's own socket or route when appropriate.
- Stable runtime commands follow the verified sealed control selection through
  [deployment dispatchers](docs/runbooks/DEPLOYMENT.md); preserve application-only
  rollback's separate controller and the disposable installed-command acceptance.
  Native release acceptance explicitly selects the host's GNU timeout dependency;
  see [durability acceptance](docs/architecture/PROTECTED-DURABILITY-OBSERVATION.md#isolated-acceptance-and-live-gate).
- Merge a checked pull request with `scripts/merge-pr.sh <number>`, which serialises
  merges so concurrent fixes stop invalidating each other's required check; see
  [merge lane](docs/runbooks/DEPLOYMENT.md#merge-lane).
- For dirty task worktrees, use the
  [guarded rebase command](docs/runbooks/DEPLOYMENT.md#worktree-rebases);
  it preserves unpublished edits and refuses rewrites of pushed history.
- Every commit carries an `Update-note:` sentence in product language and a
  `Failure-record:` trailer naming its replayable failure record or `none`.
  The [update-note rule](docs/runbooks/DEPLOYMENT.md#update-notes-for-every-commit) and
  [failure record guide](docs/incidents/README.md) own the formats. A pushed
  commit is not an installed release. Pushed history is never rewritten; the
  [deployment runbook](docs/runbooks/DEPLOYMENT.md) records the enforced path.
- Keep credentials and private dialogue out of unrelated prompts, logs and public
  artifacts. Preserve the authenticated data and capability boundaries in
  [session ownership](docs/architecture/SESSION-OWNER.md) and
  [agent security](docs/security/2026-10-07-agent-security-review.md).
- Agent session commands use each machine's installed wrapper, which selects
  the current release; see [runner command paths](docs/architecture/RUNNERS.md#agent-session-commands).
- Claude history payload retirement preserves full SDK rows and the runner
  mirror until the [exact-generation maintenance gate](docs/runbooks/DEPLOYMENT.md#history-cache-maintenance)
  proves production custody, recovery, and page/detail behavior. The
  [object-backed history plan](docs/plans/2026-11-12-concierge-history-object-retirement.md)
  owns the cutover invariants. Optional attempt recovery and the independent
  release-reader compatibility fence and product-owned small-cache backup admission
  are documented at that maintenance gate. Its diagnostic entrance records an
  observer-only baseline and one unchanged guarded trial; preserve the production
  hold and coordinate host archive validation before any live observation. The
  disposable report retains byte digests and accepted snapshot/readback evidence
  across owned cleanup; see that same maintenance gate for missing-proof semantics.
  The [numeric durability observer](docs/architecture/PROTECTED-DURABILITY-OBSERVATION.md)
  has a separate bounded lifetime; never extend maintenance to fit observation. Read cache
  allocation through [router actions](docs/runbooks/ROUTER-ACTIONS.md#agent-session-communication).
  The [protected durability observation](docs/architecture/PROTECTED-DURABILITY-OBSERVATION.md)
  defines the private host read, lane boundaries and coverage gaps; it changes no
  admission policy and authorizes no additional live trial.
- Exact ChatGPT answer handling after a supported tool read preserves provider-return evidence; see [answer obligations](docs/architecture/CHATGPT-ANSWER-OBLIGATIONS.md#explicit-confirmation-after-a-supported-tool-read).
- Managed native Codex helper edit identity and parent-turn retention follow [provider sessions](docs/architecture/PROVIDER-SESSIONS.md); the Nov 13 lifecycle failure and replay are [here](docs/incidents/2026-11-13-codex-helper-lifetime.md), preserving the earlier [Nov 12 attribution incident](docs/incidents/2026-11-12-codex-helper-edit-gate.md).
- Marked messages held by per-session Pause retain their original admission identity;
  see [session recovery](docs/architecture/SESSION-OWNER.md#identity-and-admission).
- Exact predecessor/successor file-watch inspection and quiet retirement use retained recovery
  and work-delegation custody, not cross-session list/cancel; see
  [watch custody](docs/architecture/WATCHES.md#exact-pair-recovery-custody).

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
- Preserve exact accepted input, run, action, source-message and target
  identity; do not replay ambiguous or acknowledged effects. Keep human
  authorship distinct from agent and service inputs. See the
  [wire contract](docs/contracts/session-owner-v1.md),
  [human command custody](docs/architecture/HUMAN-COMMAND-INTAKE.md), and
  [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md).
- A Stop on adopted Codex work follows the original provider turn through exact
  history reconciliation; missing identity or terminal evidence stays uncertain
  and never resubmits the accepted input. See
  [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md#stop-while-taking-back-an-existing-codex-turn).
  The one-time source-bound native recovery controls and post-release acceptance procedure are
  documented in [the Codex recovery runbook](docs/runbooks/CODEX-NATIVE-RECOVERY-ACCEPTANCE.md).
- Empty, unacknowledged service report-backs use a separate exact-input recovery with durable
  deduplication and immutable result history; see [router actions](docs/runbooks/ROUTER-ACTIONS.md#exact-codex-report-back-recovery)
  for read-only continuation inspection and owned model-start guard evidence, and
  [the incident evidence](docs/runbooks/CODEX-EMPTY-REPORT-BACK-RECOVERY-EVIDENCE.md).
  The [managed mutation fence](docs/architecture/CODEX-MUTATION-FENCE.md) owns
  forwarding permits, writer lifetime, private original-history proof, exact-input guards and the explicit
  accepted-binding activation hold; source fixtures do not lift it.
- Final replies expire only questions linked to that dispatch; repair an older
  sibling expiry through the exact-event restoration described in the
  [native Inbox contract](docs/contracts/native-inbox.md).
- Bug-button intake stays independent; later duplicate-report consolidation retains the
  human correction and acting agent, while scoped secondary routing keeps the original
  report in its primary topic. See [native Inbox](docs/contracts/native-inbox.md).
- The canonical owner enforces Inbox placement, attention and delivery. Unfiled
  human inputs prevent the Inbox router from ending its turn; human work
  requests close only on evidence for their exact obligation. See
  [native Inbox](docs/contracts/native-inbox.md),
  [filing before stopping](docs/contracts/native-inbox.md#filing-before-stopping),
  and [requested phone delivery](docs/contracts/requested-phone-notifications.md).

## Find the authority

| Work | Current authority |
| --- | --- |
| Sessions, queues, steering, Stop, peer handoff and recovery | [Session owner](docs/architecture/SESSION-OWNER.md), [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md), [wire contract](docs/contracts/session-owner-v1.md) |
| Outside agent asks and exact unstarted withdrawal | [Session owner wire contract](docs/contracts/session-owner-v1.md), [router actions](docs/runbooks/ROUTER-ACTIONS.md#outside-agents) |
| Inbox topics, routing, areas, thread replies, attention and prepared-worker catch-up | [Native Inbox](docs/contracts/native-inbox.md), [areas](docs/architecture/AREAS-OF-INTEREST.md), [prompt answers](docs/architecture/PROMPT-THREAD-ANSWERS.md), [prepared topics](docs/architecture/PREPARED-TOPICS.md) |
| Provider binding, accounts, usage, fresh Claude commands from agent shells, history and external workers | [Provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md), [provider sessions](docs/architecture/PROVIDER-SESSIONS.md), [usage](docs/architecture/PROVIDER-USAGE.md), [history index](docs/architecture/PROVIDER-HISTORY-INDEX.md), [execution host](docs/architecture/EXECUTION-HOST.md) |
| Google quota disagreement evidence, conflicting meter readings and current-input outcome attribution | [Google quota diagnostics](docs/architecture/PROVIDER-USAGE.md#google-quota-disagreement-evidence), [native input attribution](docs/architecture/PROVIDER-SESSIONS.md#antigravity-sessions) |
| Explicit ChatGPT projects, custom GPT retirement and retained-run recovery | [ChatGPT requests](docs/runbooks/ROUTER-ACTIONS.md#agent-session-communication), [wire contract](docs/contracts/session-owner-v1.md) |
| Provider sign-in renewal through the Mac's saved browser account, including its bounded pre-auth browser retry | [Sign-in approval](docs/runbooks/CLAUDE-SIGNIN-APPROVAL.md), [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md) |
| Exact thnkr.ing Mac web-app inspection, native AX update recovery, human authorization and direct Codex update proof | [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md), [peer instances](docs/runbooks/PEER-INSTANCES.md) |
| Isolated headless Mac browser fallback and thnkr.ing's source-bound read ticket | [Peer instances](docs/runbooks/PEER-INSTANCES.md) |
| Shared Codex App Server lifecycle, post-turn process audit and session observation | [Execution host](docs/architecture/EXECUTION-HOST.md), [Codex App Server](docs/runbooks/CODEX-APP-SERVER.md), [external Codex turns](docs/architecture/SESSION-OWNER.md#externally-submitted-codex-turns) |
| Codex CLI project trust, 0.166/0.169 compatibility, and isolated launch exemptions | [Command-line project trust](docs/runbooks/CODEX-APP-SERVER.md#project-trust-for-command-line-work) |
| Owner on its own app server, agents' network entrance and tokens, runner lease protocol | [Runners](docs/architecture/RUNNERS.md), [execution host](docs/architecture/EXECUTION-HOST.md) |
| Runner reads of report source chains and bounded report windows | [Runners](docs/architecture/RUNNERS.md) |
| Agent browser acceptance for one created provider session | [Agent browser acceptance](docs/architecture/AGENT-BROWSER-ACCEPTANCE.md) |
| Explicit disposable native Codex test selection, deadline and source-bound fault controls | [Router actions](docs/runbooks/ROUTER-ACTIONS.md#disposable-native-codex-tests), [session-owner wire contract](docs/contracts/session-owner-v1.md), [native Codex acceptance](docs/runbooks/CODEX-NATIVE-RECOVERY-ACCEPTANCE.md) |
| Runner-resolved project folders, standing-agent schedule targets and bounded project file, TODO, worktree, Google and outside-run operations | [Runners](docs/architecture/RUNNERS.md#runner-machine-calls), [router actions](docs/runbooks/ROUTER-ACTIONS.md#standing-agents) |
| Provider accounts, sign-in custody and account homes on runners | [Runners](docs/architecture/RUNNERS.md#provider-accounts-on-runners), [provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md) |
| Bounded reads, owner-block I/O evidence, SQLite ledger durability and diagnostic snapshots | [Storage observation](docs/architecture/STORAGE-OBSERVATION.md), [ledger durability](docs/architecture/LEDGER-DURABILITY.md), [native read execution](docs/architecture/NATIVE-READ-EXECUTION.md), [diagnostic snapshot](docs/runbooks/DIAGNOSTIC-SQLITE-SNAPSHOT.md) |
| Stop-hook owed replies and isolated Inbox filing reads | [Native read execution](docs/architecture/NATIVE-READ-EXECUTION.md), [filing before stopping](docs/contracts/native-inbox.md#filing-before-stopping) |
| Releases, autonomous repair, host alerts and Mac installation | [Deployment](docs/runbooks/DEPLOYMENT.md), [repair architecture](docs/architecture/DEPLOYMENT-REPAIR.md), [repair agent](docs/runbooks/REPAIR-AGENT.md), [Grafana alerts](docs/runbooks/GRAFANA-ALERTS.md), [peer instances](docs/runbooks/PEER-INSTANCES.md) |
| Project, session, Inbox and saved-work commands | [Router actions](docs/runbooks/ROUTER-ACTIONS.md), [saved work](docs/plans/2026-09-23-saved-work-scheduled-and-banked.md) |
| Filtered Mac Messages reads, including bounded historical conversation windows and code withholding | [Router actions](docs/runbooks/ROUTER-ACTIONS.md#reading-his-texts-mac) |
| Canvas project binding and current board title beside stable project folders | [Router actions](docs/runbooks/ROUTER-ACTIONS.md), [wire contract](docs/contracts/session-owner-v1.md#peer-instances) |
| Mac and server Lab reads and writes | [Router actions](docs/runbooks/ROUTER-ACTIONS.md#discussing-in-the-lab); the server holds the Lab key and the peer channel carries Mac calls under their own source identity |
| Captures, audio, speech and Canvas observations | [Capture ingress](docs/architecture/CAPTURE-INGRESS.md), [Thinkering capture](docs/runbooks/THINKERING-CAPTURE.md), [speech](docs/architecture/SPEECH-FALLBACK-JOBS.md), [Workers AI speech and search embeddings](docs/architecture/WORKERS-AI.md), [Canvas think-aloud](docs/architecture/canvas-think-aloud.md) |
| Current-versus-historical documentation | [Documentation index](docs/README.md); plans and incidents are evidence, not authority for current behavior |

Update the relevant current-state document in the same commit when behavior or
ownership changes. Keep `CLAUDE.md -> AGENTS.md` as the same-directory symlink.
Final responses through Concierge start with `TL;DR:`, distinguish committed
work from installed and observed behavior, and leave the provider-reported
model and working-folder footer to Concierge.
