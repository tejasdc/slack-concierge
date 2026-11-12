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
- Merge a checked pull request with `scripts/merge-pr.sh <number>`, which serialises
  merges so concurrent fixes stop invalidating each other's required check; see
  [merge lane](docs/runbooks/DEPLOYMENT.md#merge-lane).
- Rebase dirty task worktrees with `scripts/rebase-worktree.sh`, which saves tracked
  changes under a ref private to that worktree and restores the exact saved object.
  It refuses branches already pushed to origin, preserving published history.
  It refuses untracked files until staged or committed; after a stopped rebase,
  resolve or abort it and run `scripts/rebase-worktree.sh --restore` from a clean tree.
  A conflicted restore must be resolved and finished with its exact saved object ID,
  never applied a second time.
  See [worktree rebases](docs/runbooks/DEPLOYMENT.md#worktree-rebases).
- Concierge service stops during a release go through the deployment controller's
  [attributed systemd stop path](docs/runbooks/DEPLOYMENT.md#runtime-dependencies-and-service-shutdown).
- Planned drain stops Codex lifecycle observation before awaited shutdown work;
  see the [deployment runbook](docs/runbooks/DEPLOYMENT.md#runtime-dependencies-and-service-shutdown).
- Unanswered capture claims cancel on service stop under the existing claim and recovery
  contract; see [capture ingress](docs/architecture/CAPTURE-INGRESS.md).
- Operator-controlled offline releases stop the old owner before candidate activation;
  see the [deployment runbook](docs/runbooks/DEPLOYMENT.md#runtime-dependencies-and-service-shutdown).
- Owner startup timing and deferred history catch-up follow the
  [deployment startup contract](docs/runbooks/DEPLOYMENT.md#owner-startup-and-history-catch-up).
- Runner sign-ins reserve against the deployment drain before launching their provider CLI;
  see the [deployment runbook](docs/runbooks/DEPLOYMENT.md)
  and [interruption record](docs/incidents/2026-11-06-signin-started-inside-deployment-drain.md).
- Candidate schema comparison and its bounded read-only SQLite lock recovery
  follow the [deployment runbook](docs/runbooks/DEPLOYMENT.md#candidate-schema-comparison).
  Its offline migration phase timings and backup boundary are in the same
  [deployment runbook](docs/runbooks/DEPLOYMENT.md#runtime-dependencies-and-service-shutdown).
- Owner-loop pause evidence comes from the separate watchdog thread; interpret its
  bounded Linux wait samples through [storage observation](docs/architecture/STORAGE-OBSERVATION.md#owner-loop-pause-evidence).
- A repair-owned deployment run ends its old transient runner without reclaiming the repair;
  see [automatic failure behavior](docs/runbooks/DEPLOYMENT.md#automatic-failure-behavior).
- The release build refuses a bundle that uses a name nothing defines or imports
  (`bot/scripts/undefined-name-check.ts`); `bun build` alone ships such a name as a runtime
  reference error. Peer answers are awaited time, never owner time. See the
  [missing-import record](docs/incidents/2026-11-07-routed-message-projection-missing-import.md)
  and [peer reply wait record](docs/incidents/2026-11-07-peer-reply-read-counted-as-owner-time.md).
- Every commit carries an `Update-note:` sentence in product language and a
  `Failure-record:` trailer naming its replayable failure record or `none`.
  The [update-note rule](docs/runbooks/DEPLOYMENT.md#update-notes-for-every-commit) and
  [failure record guide](docs/incidents/README.md) own the formats. A pushed
  commit is not an installed release. Pushed history is never rewritten; the
  [deployment runbook](docs/runbooks/DEPLOYMENT.md) records the enforced path.
- Protected agent code launches hide the live ledger and its disk image while allowing Thinkering's
  phone-width release check to mount its read-only data view. The
  [deployment runbook](docs/runbooks/DEPLOYMENT.md) owns the isolation contract.
- The current machine copy guard recognizes the agent-ecology committee's direct help forms while
  retaining live-ledger copy refusals; see the [deployment runbook](docs/runbooks/DEPLOYMENT.md)
  and [failure record](docs/incidents/2026-11-06-committee-help-copy-guard.md).
- Background command watches have Concierge ownership and deadlines; completed Codex turns
  flag surviving server processes outside their owned execution unit by exact run identity
  through an Inbox agent report.
  See [execution host](docs/architecture/EXECUTION-HOST.md#agent-browser-process-ownership)
  and [durable watches](docs/architecture/WATCHES.md).
- A request awaiting a specific Concierge repair uses a commit-scoped renewing release watch;
  unrelated releases and lease renewals stay quiet. See [durable watches](docs/architecture/WATCHES.md).
- Project creation validates organizer placement in the owner ledger and performs scaffold and
  GitHub work as a replay-safe job on the configured project runner. See [runners](docs/architecture/RUNNERS.md).
- Hosted run adoption and parked-run recovery follow the
  [execution host](docs/architecture/EXECUTION-HOST.md) contract; never reset their ledger status by hand.
- Legacy conversation runner recovery uses the most recent launched host, excluding unclaimed
  execution intents; see [runners](docs/architecture/RUNNERS.md).
- Outside Codex repair sessions use a one-input command line and take follow-ups
  in the next turn; a runner-hosted outside turn is adopted through that runner's
  retained journal; see [router actions](docs/runbooks/ROUTER-ACTIONS.md#outside-requests)
  and [execution host](docs/architecture/EXECUTION-HOST.md#codex-runs-design-step-5).
- Keep credentials and private dialogue out of unrelated prompts, logs and public
  artifacts. Preserve the authenticated data and capability boundaries in
  [session ownership](docs/architecture/SESSION-OWNER.md) and
  [agent security](docs/security/2026-10-07-agent-security-review.md).
- Fresh agent-started Claude Code commands skip older Concierge wrappers in PATH and tolerate the package install's brief
  missing-command window before account selection; see the
  [provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md#claude-code-started-by-an-agent).
- Mac agent replies may quote browser and Computer Use diagnostics without the surface guard treating
  that report text as an action; the standalone reply and actual action boundary are in
  [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md).
- Shared Codex turn recovery and its exact identity boundary follow
  [provider sessions](docs/architecture/PROVIDER-SESSIONS.md#codex-provider-turn-reconciliation).
- Confirmed Claude process death after a checkpoint uses the existing bounded continuation;
  see [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md#confirmed-claude-process-death-after-work).
- Antigravity follow-ups wait as durable separate turns; recovery of proven never-written
  legacy follow-ups follows [provider sessions](docs/architecture/PROVIDER-SESSIONS.md#antigravity-sessions).
- Runner account admission failures keep unsent turns retryable; the runtime error
  that briefly masked this behavior is recorded in the
  [dispatch failure record](docs/incidents/2026-11-06-provider-dispatch-error-unbound.md).
- Agent session command paths use each machine's installed wrapper, never a release's
  helper directory; see [runners](docs/architecture/RUNNERS.md#agent-session-commands).
- Runner-owned Codex account switches prove the new login through the bridge inside the sealed
  release; see [runner App Server](docs/architecture/RUNNERS.md#codex-app-server-on-a-runner-built-off-until-concierge_codex_runner-is-set).
- Restricted Claude consultations preserve the selected runner account while excluding action
  credentials; see [provider sessions](docs/architecture/PROVIDER-SESSIONS.md#selection-and-binding).
- Agent-started top-model choices, implementation handoffs and helper defaults follow [provider sessions](docs/architecture/PROVIDER-SESSIONS.md#delegation-and-escalation);
  measured model calls, code edits, project, session and helper tokens follow [usage](docs/architecture/PROVIDER-USAGE.md#who-used-the-allowance).
- External Codex resets on a saved account clear that account's older refusal on a fresh direct reading before automatic account switching; see [provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md#what-the-allowance-evidence-means).
- The Mac peer's per-session usage breakdown reads its local transcript history when it has no provider runners; stale results are marked rather than silently presented as current. See [provider usage](docs/architecture/PROVIDER-USAGE.md#who-used-the-allowance).
- The prepared word search keeps one copy of dialogue only (tool evidence comes from the archive index) and returns freed pages without VACUUM; its size budget and the paced move from the old layout are in [prepared search](docs/architecture/PREPARED-SEARCH.md).
- Weekly subscription allowance attribution, its coverage, and the compact Threads/Sessions lookup follow [provider usage](docs/architecture/PROVIDER-USAGE.md#who-used-the-allowance).

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
- Separately accepted Inbox replies stay visible even when their words match; only an
  explicit multi-request reply shares one answer. See [prompt thread answers](docs/architecture/PROMPT-THREAD-ANSWERS.md)
  [decision: fix-protocols-never-hide-duplicates].
- Held final returns retry delivery to their asker while completed Inbox answer
  upkeep is retained once per exact event; the yielding open-thread sweep is
  described in [native Inbox](docs/contracts/native-inbox.md#owner-upkeep-under-held-returns).
- Thread upkeep admitted as no-reply service work can settle quietly after reconciliation;
  the [native Inbox thread contract](docs/contracts/native-inbox.md) keeps agent answers
  and ordinary service returns subject to their thread reply obligation.
- ChatGPT questions carry an exact task and remain open through failed attempts,
  return receipt, and explicit answer handling; accepted handoffs move open answer
  duties to the successor. See [ChatGPT answer obligations](docs/architecture/CHATGPT-ANSWER-OBLIGATIONS.md)
  and [session handoff](docs/architecture/SESSION-OWNER.md#provider-change-handoff).
- Preserve exact accepted input, run, action, source-message and target identity.
  An informational wake does not retire a delivered open work request; delegated
  work keeps its exact authority input and source run. See the [session owner wire contract](docs/contracts/session-owner-v1.md#forwarded-input-provenance).
  Continuation ancestry visits each source input once because valid service inputs
  can point to themselves; see the [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md).
  Do not replay ambiguous or acknowledged effects. Keep human authorship distinct
  from agent and service inputs. The [session owner wire contract](docs/contracts/session-owner-v1.md),
  [human command custody](docs/architecture/HUMAN-COMMAND-INTAKE.md), and
  [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md) own those boundaries.
- Routed thread roots created by an earlier Inbox session resolve their retained input anchor
  through the shared Inbox lineage when a successor files an answer; see the
  [native Inbox contract](docs/contracts/native-inbox.md) and
  [final answer foreign-key failure record](docs/incidents/2026-11-12-final-answer-routed-root-foreign-key.md).
- Banked phone work that Tejas permits only overnight uses the explicit quiet-only saved-work choice; request cancellation also revokes a queued saved turn. See [session ownership](docs/architecture/SESSION-OWNER.md#one-execution-owner) and [router actions](docs/runbooks/ROUTER-ACTIONS.md#current-native-routing).
- Daily local repeats retain their wall time and IANA zone on Concierge's existing saved turn; migrate a live repeat by its exact queued turn instead of creating a second session. See [router actions](docs/runbooks/ROUTER-ACTIONS.md#standing-agents) and [session ownership](docs/architecture/SESSION-OWNER.md#one-execution-owner).
- Saved-work cancellation names one turn and retains its cause; accepted handoff preserves an unfired scheduled turn's due time and firing identity. See [session ownership](docs/architecture/SESSION-OWNER.md#identity-and-admission) and [provider-change handoff](docs/architecture/SESSION-OWNER.md#provider-change-handoff).
- A device question can ask for one hand gesture (tap, press, click, drag, plug-in) on a named
  device of his, name a physical instrument or controller in a USB connection
  request, an app startup when the device has no agent route, or one spoken launch on
  a physical Echo; the agent explains the failed route. See
  [router actions](docs/runbooks/ROUTER-ACTIONS.md). Returned `needs_you` questions can be withdrawn
  by exact event identity when they become stale. See [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md)
  and the [session owner contract](docs/contracts/session-owner-v1.md).
- Provider sign-in repair requests to the Mac may come from a batch of owner repair
  notices; the private Mac admission rule and replay case are in the
  [batched renewal failure record](docs/incidents/2026-11-06-batched-signin-repair-refused-by-mac.md).
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
- A question linked to an exact to-do is rechecked in the background when Inbox attention,
  question and thread views are opened (never awaited by the read); a Done or Dropped to-do settles that question. Its attention
  event carries the to-do ID for thnkr.ing's final notification check. See
  [requested phone notifications](docs/contracts/requested-phone-notifications.md).

## Find the authority

| Work | Current authority |
| --- | --- |
| Sessions, queues, steering, Stop, peer handoff and recovery | [Session owner](docs/architecture/SESSION-OWNER.md), [turn lifecycle](docs/architecture/TURN-LIFECYCLE.md), [wire contract](docs/contracts/session-owner-v1.md) |
| Outside agent asks and exact unstarted withdrawal | [Session owner wire contract](docs/contracts/session-owner-v1.md), [router actions](docs/runbooks/ROUTER-ACTIONS.md#outside-agents) |
| Inbox topics, routing, areas, thread replies, attention and prepared-worker catch-up | [Native Inbox](docs/contracts/native-inbox.md), [areas](docs/architecture/AREAS-OF-INTEREST.md), [prompt answers](docs/architecture/PROMPT-THREAD-ANSWERS.md), [prepared topics](docs/architecture/PREPARED-TOPICS.md) |
| Provider binding, accounts, usage, fresh Claude commands from agent shells, history and external workers | [Provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md), [provider sessions](docs/architecture/PROVIDER-SESSIONS.md), [usage](docs/architecture/PROVIDER-USAGE.md), [history index](docs/architecture/PROVIDER-HISTORY-INDEX.md), [execution host](docs/architecture/EXECUTION-HOST.md) |
| Provider sign-in renewal through the Mac's saved browser account, including its bounded pre-auth browser retry | [Sign-in approval](docs/runbooks/CLAUDE-SIGNIN-APPROVAL.md), [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md) |
| Exact thnkr.ing Mac web-app inspection, native AX update recovery, human authorization and direct Codex update proof | [Mac agent awareness](docs/architecture/MAC-AGENT-AWARENESS.md), [peer instances](docs/runbooks/PEER-INSTANCES.md) |
| Isolated headless Mac browser fallback and thnkr.ing's source-bound read ticket | [Peer instances](docs/runbooks/PEER-INSTANCES.md) |
| Shared Codex App Server lifecycle, post-turn process audit and session observation | [Execution host](docs/architecture/EXECUTION-HOST.md), [Codex App Server](docs/runbooks/CODEX-APP-SERVER.md), [external Codex turns](docs/architecture/SESSION-OWNER.md#externally-submitted-codex-turns) |
| Owner on its own app server, agents' network entrance and tokens, runner lease protocol | [Runners](docs/architecture/RUNNERS.md), [execution host](docs/architecture/EXECUTION-HOST.md) |
| Runner reads of report source chains and bounded report windows | [Runners](docs/architecture/RUNNERS.md) |
| Agent browser acceptance for one created provider session | [Agent browser acceptance](docs/architecture/AGENT-BROWSER-ACCEPTANCE.md) |
| Runner-resolved project folders, standing-agent schedule targets and bounded project file, TODO, worktree, Google and outside-run operations | [Runners](docs/architecture/RUNNERS.md#runner-machine-calls), [router actions](docs/runbooks/ROUTER-ACTIONS.md#standing-agents) |
| Provider accounts, sign-in custody and account homes on runners | [Runners](docs/architecture/RUNNERS.md#provider-accounts-on-runners), [provider state flow](docs/architecture/PROVIDER-STATE-FLOW.md) |
| Bounded reads, owner-block I/O evidence, SQLite ledger durability and diagnostic snapshots | [Storage observation](docs/architecture/STORAGE-OBSERVATION.md), [ledger durability](docs/architecture/LEDGER-DURABILITY.md), [native read execution](docs/architecture/NATIVE-READ-EXECUTION.md), [diagnostic snapshot](docs/runbooks/DIAGNOSTIC-SQLITE-SNAPSHOT.md) |
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
