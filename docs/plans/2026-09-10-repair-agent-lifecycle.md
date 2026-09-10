# Repair agents with explicit process ownership and bounded recovery

Status: Claude Fable 5.1 design review complete. One final controller-recovery correction is proposed below for the user decision required by the three-verdict review limit. No implementation or deployment is claimed.

## Goal and operating profile

Repair the observed deployment incident and prevent a failed repair supervisor from silently retrying forever. This is one coherent change, including its control-code recovery path and tests. Concierge is one trusted operator's Bun/TypeScript service on one Linux host, using SQLite, systemd, existing Codex sessions, Git, and immutable deployment artifacts. Preserve those owners; introduce no workflow framework, broker, daemon, credential, or idle polling.

The application must remain on its proven healthy release while repair work proceeds. Ordinary feature agents continue to end at commit/push. Repair agents edit and commit; independent review judges the actual diff; deterministic code owns integration, activation, rollback, and notices. The shared Codex App Server is outside this change.

## Responsibility boundaries

| Owner | Durable responsibility | Allowed effects |
| --- | --- | --- |
| Deployment runner | Candidate, healthy release, activation intent and health proof | Drain, activate, restart, restore and promote through existing release tooling |
| Repair supervisor | Incident ownership, process attempts, checkpoints and finite recovery budget | Start one repair/review child, reap it, validate results, integrate reviewed Git and request retry |
| Repair agent | Diagnosis and committed correction in the incident worktree | Inspect evidence, edit the scoped repository, run tests and commit; no push or deployment |
| Independent reviewer | Verdict tied to the exact base, revision and executable evidence | Read and test the complete correction; no deployment |
| Existing Slack projector | Exact reaction and failure-notice targets with durable delivery identity | Update status and deliver one terminal notice per attributable thread |

The supervisor owns whether work may execute. The agent supplies a correction; its prose never substitutes for a process identity, review verdict, successful executable check, or rollout health proof.

## Observed incident and containment

Deployment `4d2904d3-fb95-4e2e-923b-94e693181849` was initiated for the Fable 5.1 default-model change, commit `aa7f47e`. The rollout failed in admission drain with SQLite writer contention, before activating that change. The incident is `c8cb5bb7-da17-49f9-bf35-da4f438f3019`; healthy application and control remain at the artifact for `724732b`.

The first repair committed `0beea2e`, adding a busy timeout to drain's connection. Review rejected it because the retry still runs the old immutable control bundle. A correct source change is insufficient when the retry executes different bytes.

On the correction attempt, `runPersistedAgent` bound the known session UUID before spawning. `recordDeploymentRepairChild` accepts only `launch_intended`, so the subsequent PID write rejected `session_bound`. An exception escaped after spawning and before output/exit ownership was attached. The supervisor exited; systemd restarted it every ten seconds; each restart created another attempt with the same incompatible ordering. There were over 2,900 restarts after the first rejected review. The existing limits count review verdicts and candidate failures, so neither counted this supervisor failure.

For containment, the exact incident unit was stopped and runtime-masked. No application, capture, or shared provider service was stopped; no incident, worktree, commit, or transcript was deleted. The mask is temporary incident containment and must be removed only as part of handing ownership to verified corrected repair machinery.

## Invariants

1. A repair conversation persists across attempts. A process attempt has a separate identity and finite outcome. Knowing a conversation ID never proves a process has started or acknowledged input.
2. At most one live supervisor and one owned child may mutate an incident's worktree. A second owner must prove the previous process identity dead. Ambiguous ownership parks; it never authorizes another writer.
3. Every spawned child is immediately owned through exit and output closure, including when persistence or callbacks fail.
4. Every failure either advances a durable checkpoint, consumes a bounded recovery attempt, or parks with one durable notice. Restarting a process is not progress and does not reset the bound.
5. Review and execution refer to exact immutable code. A repaired file that is absent from the actual retry executable cannot satisfy acceptance.
6. Control repair must not require the broken deployment operation to succeed first. It also must not silently replace the healthy application's rollback authority.

## Session and attempt records

Keep the existing incident and `deployment_repair_agent_runs` tables. Make the requested resume UUID an explicit immutable field on the new attempt, written with launch intent. Retain `session_uuid` as the session identity observed from native provider evidence. A completed prior repair supplies the requested resume UUID for a correction; a new review revision starts a fresh review conversation. Resuming an interrupted review keeps its exact review revision and output identity. Add columns through explicit additive migrations; `CREATE TABLE IF NOT EXISTS` does not migrate an existing table.

The attempt lifecycle is:

```text
launch intent (optional requested session)
  -> child identity recorded
  -> matching provider session confirmed
  -> child exited, output closed, result recorded
  -> validated commit or review checkpoint
```

These are facts with independent fields, not an overloaded session-bound phase gate. PID recording checks attempt ownership, nonterminal status, and absent-or-identical child identity. It does not depend on whether a session UUID is known. Provider acknowledgement checks the requested UUID and rejects a different session. Repeated identical observations are idempotent; conflicting observations fail closed. The acknowledgement contract must be verified against the installed CLI, including a real resume. The incident has only two actual output logs, both from fresh launches; the failed resumes crashed before opening their log files. Do not invent a resume event from those fresh-launch logs. If the native resume contract does not emit an identity event, successful completion and the validated result of an explicit-UUID resume establish its outcome; the prior requested UUID is not presented as a new acknowledgement at spawn time.

Persist output and final-result paths with attempt intent, before spawn. Recover a completed attempt from that exact result instead of creating a replacement filename or rerunning work. Advance repair/review checkpoints only after validating the result against the exact revision. Preserve existing rows during migration; legacy attempts retain their recorded provider identity and process evidence. No timestamp-based reconstruction of another conversation is allowed.

## One process owner and one recovery policy

Make incident claiming a transaction that verifies the current supervisor's PID/boot/start identity before replacing it. Recheck ownership before launching a child, recording a checkpoint, or integrating a commit. Existing process identity checks and SQLite provide the boundary; a new coordination service is unnecessary. For legacy rows lacking a child PID, require proof that the prior supervisor is dead and its exact unit cgroup is empty before granting another writer. An inactive unit label alone is insufficient evidence of an empty cgroup. Preserve this proof with the operator transition. A known prior session can then be resumed if the incident remains runnable; uncertain process ownership parks.

The process adapter installs error, output, and completion handling before invoking persistence callbacks. Spawn failure, callback failure, malformed provider events, mismatched UUID, nonzero exit, and failed result validation all return a structured attempt outcome. If bookkeeping fails after spawn, terminate and reap the exact owned child, finish its output, then report failure. Do not leave a child running after the supervisor abandons its bookkeeping. Service shutdown retains `KillMode=control-group` to cover descendants.

Use the existing SQLite busy timeout/retry policy on every short-lived deployment database connection, including the bundled drain CLI. Do not hold a database transaction while waiting for a process, Git, Slack, or a network call. Contention within the bounded storage contract is not a model-repair request.

Count every new supervisor process at claim time, in the ownership transaction, before any external work. Allow at most three attempts at an unchanged durable checkpoint, including the first attempt. An idempotent claim by the same process does not consume another attempt. A fourth owner is refused and parks the incident; an observed failure on the third attempt parks immediately. This rule covers every failure, including errors outside anticipated categories and crashes before an exception handler runs. Classification decides whether the same session can resume or whether the attempt must park immediately; it never exempts a start from accounting.

Persist the count and checkpoint on the incident. Only a new validated commit, a recorded review of its exact revision, or a verified deployment checkpoint resets the count. Re-recording the same commit, rewriting a status during dead-owner recovery, launching a process, or acknowledging a session is not progress. Keep the existing four-review and three-same-candidate-failure limits. Known invariant violations or uncertain effect ownership park immediately even with budget remaining.

Systemd remains process supervision, not the retry policy. A durably parked incident exits successfully or with a non-restarting terminal exit code. Add an explicit native start-rate limit whose interval actually spans the configured restart delay as a final guard against code that fails before SQLite can record the stop. The worker must respect durable parking and must not reset the OS limit or create a new incident to evade the budget. A start-limit failure observed by the existing worker parks the incident and schedules the existing durable notification projection. If SQLite itself is unavailable, preserve the error in journald and let the native start bound stop the process; reconcile to a durable parked notice on the next existing lifecycle/startup signal once persistence returns. A temporarily masked unit is operator containment, not permission to start a competing direct process.

## Executing repaired control code

Keep one global `control`/LKG authority. Do not add an incident-specific controller artifact selector. Normal repair retries execute the installed control bundle, so a source-only correction cannot claim to repair an operation still executed by older bytes. Exact bundled-entrypoint acceptance enforces that boundary. If the controller itself is broken, autonomous repair parks and an explicit operator recovery upgrades it. There is no recursive agent that repairs the repair supervisor.

Use the existing dual-provenance release shape: the healthy application commit plus the exact reviewed control commit. A bounded operator recovery entrypoint composes the existing release/run functions, following the useful part of `deployment-repair-cutover.sh`; it does not rerun that legacy cutover or its retirement actions, and never calls ordinary `deploy()`, which would replace the intended healthy application commit with origin's candidate.

The recovery is one operation with these durable boundaries:

1. **Verify and contain.** Require the exact reviewed control revision integrated into origin, a clean task-owned source checkout at that revision, its recorded tree digest, and focused acceptance of the built control commands. The operator explicitly authorizes executing this verified checkout for bootstrap; normal deployment remains immutable-artifact-owned. Apply additive migrations before the corrected code can run. Prove the old supervisor dead and the exact repair unit cgroup empty. Upgrade temporary containment to a native repair-template mask that survives a host restart before changing run ownership. The reviewed operator tool owns this mask and records the prior unit's artifact provenance; it may replace that exact installed template with systemd's `/dev/null` mask through its installation path, never edit bundle contents. This affects only autonomous repair admission, not ordinary provider or capture work. A runtime-only mask is insufficient because reboot would re-enable the broken supervisor.
2. **Transfer the active run atomically.** In one SQLite transaction, park the old incident with an audited reason naming the recovery revision and replacement run; reserve a new operator deployment run; and claim that new run with the recovery process's PID/boot/start identity. The worker never sees an unowned prepared replacement. Preserve all old worktree, commit, session, attempt and output evidence. The old run gets a truthful stopped state, not success. The replacement owns no feature requests or reaction targets. **Final-review correction proposed for decision:** reserve this replacement with the existing non-null `repair_state='repairing'`, without a new agent repair incident. This keeps both the ordinary deploy list and agent-repair list from launching it after its owner dies. Its explicit recovery command owns claiming and re-entry; ordinary `claimDeploymentRun` is not the re-entry API for this reservation.
3. **Prove the healthy application with corrected control.** Use the existing user-priority deployment drain and capture gates. The drain command comes from the exact reviewed recovery source and includes its connection's busy timeout. Prepare an immutable release with `--commit <healthy-app>` and `--control-commit <reviewed-control>`; persist normal activation intent; activate only `current`; restart and run existing application/capture health checks with the expected app commit fixed to the healthy revision. Confirm that the shared App Server identity did not change. Keep global `control` at prior LKG until proof succeeds; do not use the old cutover's pre-proof `set-control` step.
4. **Promote through the existing authority.** After the exact restart and health proof, promote the hybrid release as LKG and advance global `control`. Install the normal unit definitions and runtime helpers from the promoted artifact, then remove only the masks owned by this recovery and reload systemd. Preserve any independently imposed operator mask. Release gates and record success for this operator run. The application Git commit has not advanced, so this must not project a feature 🚀 or consume its pending desired SHA.
5. **Return to ordinary deployment.** The existing worker sees healthy application commit != desired commit and starts the normal deployment using the newly promoted control. The stopped old incident remains historical; it is never revived by clearing its counters. Any new failure is owned by the corrected supervisor with its finite attempt budget. User work continues to have priority at the deployment gate.

Controller recovery failure never calls the ordinary autonomous-repair handoff. Its trap restores and re-proves the database-authoritative LKG if activation began, releases gates when safe, and records the operator run's failure. After a successful LKG promotion, recovery must respect that newer authority rather than restore obsolete pointers. The persistent repair mask remains until verified corrected control and its normal unit are installed.

**Final-review correction proposed for decision:** if the recovery process or host dies, the reserved run remains exclusively recoverable by the explicit operator recovery command. That command verifies the old owner dead, claims transactionally, and restores or proceeds from recorded activation intent and artifact proof. The existing pre-start dead-candidate selector excludes non-retrying repair states, so do not promise automatic application restoration for this reserved run. The hybrid uses the healthy application revision, but an interrupted recovery still requires the operator command to establish the exact artifact and health outcome before release. This is the deliberate tradeoff for keeping old controller code from re-entering the operation.

A persistent mask alone is insufficient: the installed old `deploy.sh` reinstalls its unit template and can replace the mask. The run reservation must prevent that deploy from launching in the first place. The mask is supplementary containment, not the workflow owner. Recovery preserves recorded run, artifact, current/control and mask provenance without deleting history. Native process supervision, not a new watcher, owns process lifetime.

Because this operation fixes controller ownership rather than shipping a feature, the explicit operator command is the exceptional bootstrap boundary. It reports durable handoff acceptance and returns; the detached operation owns drain, restart and proof. Ordinary feature agents still commit/push and do not wait for deployment completion.

Rejected alternatives: a permanent per-incident controller pin would teach launch, retry, boot recovery and restore two competing selection rules; a second active deployment run would violate existing single-run ownership; reusing the feature run's success transition for controller-only repair would falsely mark pending application changes deployed. The terminal audited handoff avoids all three using existing run and release records.

## Slack behavior and observability

Keep existing deployment reactions and durable notices. A supervisor failure that cannot recover becomes `parked`, projects 🛑, and emits one bounded notice on the attributable thread with the failed operation and incident reference. It must not leave 🛠️ indefinitely while no viable repair attempt exists. Counts and last failure details remain in the incident log; repeated restarts do not send repeated messages.

The current failed run has zero `deployment_requests` rows and one `deployment_turn_reactions` target. Today's failure-notice loop reads only request rows, so it cannot notify this automatic run. When request targets are absent, derive exact recipient threads from the existing reaction targets joined to their originating turns. Deduplicate by run, notice kind, channel, and visible root using the existing durable notice writer; do not infer a target from recent channel activity or send one reply per process attempt.

This change does not add a new “push waiting for another deployment” emoji, change request queues, change model defaults, or make deployment completion invoke a feature agent.

## Acceptance for the whole change

- Reproduce the current correction-after-NO_SHIP failure using actual state callbacks, then prove the corrected lifecycle preserves the same session and records a new child successfully.
- Exercise real child spawn/exit behavior with a controlled CLI fixture: missing executable, immediate exit, callback exception, conflicting session ID, valid fresh and resume events, and child cleanup. Assert no surviving owned process after failure.
- Crash at each consequential boundary: before spawn, after spawn but before PID persistence, after PID persistence, after session acknowledgement, after process/result persistence, and after a commit or review checkpoint. Recovery either resumes the proven exact owner/result or parks; it never duplicates an ambiguous writer.
- Concurrent supervisor claims cannot both proceed. Repeated dead supervisors or identical failed attempts exhaust the durable budget; a new validated checkpoint permits progress without resetting review/candidate recurrence limits.
- Test SQLite writer contention against the built drain executable, not just a source import. The expected successful short wait and bounded persistent-lock failure must both be observed.
- Test the exact operator recovery using a temporary release root, SQLite database, local Git origin, and systemd/process fixtures. Verify atomic terminal handoff/reservation/claim, dual Git provenance, exact built executable selection, unchanged desired SHA and feature reactions, LKG restoration, refusal of a changed source/artifact or unreviewed revision, persistent supplementary containment across a simulated host restart, and installation from the promoted artifact before unmasking. With the final proposed reservation, inject pre-activation and post-activation process death while a live worker runs and assert that it launches neither an ordinary deployment nor an agent repair for the reserved run. Then prove explicit operator re-entry restores or completes it without a second owner. Verify the installed normal template is a regular file and unrelated masks are preserved.
- Drive a repair incident through a claimed real Slack sandbox lane using the lane's own database, provider fixtures, and existing control surface. A controlled first repair and rejected review must produce a successful correction resume; a separate injected supervisor failure must produce one durable 🛑/notice and no endless launches. Exercise a webhook-shaped run with no request rows. Join the exact Slack targets to durable incident and attempt records. Do not run production root repair units inside a sandbox lane; prove process and systemd boundaries with controlled executables and isolated service fixtures, and use the actual built control path where control selection is asserted.
- Full repository gate after focused checks, one fresh-context whole-diff review, correction verification, and exact-source Slack acceptance. Design review is specifically Claude Fable 5.1; record its actual model identity and findings.

## Sources and implementation authorities

- Incident ledger, systemd journal, installed immutable `deployment-repair.js`, and the recorded NO_SHIP review are the observed evidence.
- `bot/src/deployment-state.ts`, `bot/src/deployment-repair-supervisor.ts`, `bot/src/deployment-worker.ts`, `bot/src/deployment-release.ts`, the deployment/control CLIs and systemd unit are the current owners.
- [SQLite busy timeout](https://www.sqlite.org/pragma.html#pragma_busy_timeout): lock waiting belongs to the connection actually executing the operation.
- [Node child process lifecycle](https://nodejs.org/api/child_process.html): error, exit, and stream closure are separate events; completion handling must own all of them.
- [systemd service policy](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html): restart prevention and native start limits provide process-level bounds, not workflow progress.

## Review outcome and bounded evidence

The requested reviewer ran as `claude-fable-5-1`, Claude Code 2.1.263, session `df37005b-ac34-4945-a9f1-0cccf9350405`. Initial review requested changes; the refinement accepted the terminal-handoff direction subject to concrete boundaries; the final review confirmed every prior blocker resolved but found the mask-replacement crash case above. Its verdict was **DESIGN CHANGES REQUIRED**, with the existing-field reservation as the smallest correction. Do not label the design approved or production-ready. The global three-verdict limit requires a user decision before continuing.

Two isolated probes support that proposed correction without implementing it:

- GNU `install -m 0644` replaced a temporary symlink with a regular file; the original temporary sink stayed unchanged. The installed old control script contains the unit-template reinstall path. A filesystem mask cannot be the only protection against that path.
- Against the existing state functions with a fresh temporary SQLite database, a dead ordinary run became `prepared` and appeared in the ordinary launch list. An otherwise identical run reserved with `repair_state='repairing'` became `releasing/repairing` and appeared in neither the ordinary launch list nor the agent-repair launch list. This proves the selection boundary, not the complete recovery workflow.

No product code was changed for these probes. Implementation, migration tests, real native resume evidence, exact-source Slack acceptance, and the complete implementation review remain outstanding. The full reviewer outputs and probe evidence are working artifacts under `tmp/reviews/`; the resolved findings and remaining decision are preserved here.
