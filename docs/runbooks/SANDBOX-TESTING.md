# Reusable Slack sandbox testing

Use this runbook to exercise an implementation worktree in the isolated
`Concierge Sandbox` workspace before pushing it. Four persistent Slack app lanes
are shared by every worktree. A claim selects one free lane, starts that
worktree's current code with fresh run state, and exclusively owns the lane app
and its browser profile until release.

This is the repeatable operating procedure. The dated [sandbox design
plan](../plans/2026-08-26-isolated-slack-acceptance.md) records the decisions and
validation history; it is not the command authority for current operation.
`config/sandbox-lanes.json`, `bot/scripts/sandbox-provision.ts`, and
`bot/scripts/sandbox-lane-control.sh` are the executable authorities.

## The ownership model

The workspace is `concierge--sandbox.enterprise.slack.com`. Each lane has one
manifest-backed app, one app DM, and three fixed public fixtures:

```text
Concierge Sandbox N / concierge-sandbox-N
app DM
#concierge-lane-N-core
#concierge-lane-N-project
#concierge-lane-N-capture
```

As of 2026-08-27, all four lane apps have been created from the tracked
manifest, installed through Slack's native app settings, given separate
app-level `connections:write` tokens, imported into private lane
configuration, and provisioned with their app DM, three channels, identity,
fixtures, and browser profile. Ordinary agents consume this baseline; they do
not repeat provisioning.

Slack exposes two different workspace identities for this Enterprise sandbox:

| Boundary | Required identity |
| --- | --- |
| Slack Web client route | Enterprise ID `E0BSKCU61EK` |
| Slack Web API, configuration, Socket Mode, readiness, and durable run | Team ID `T0BSKCUULSK` |

They are not interchangeable. The controller/runtime proof uses the API team
ID. Visual proof independently requires the Web enterprise ID in
`app.slack.com/client/E0BSKCU61EK/...` and joins it to a claimed run whose API
identity is `T0BSKCUULSK`. This dual-identity join passed live on 2026-08-27.

The following state has different lifetimes by design:

| Lifetime | Owned state |
| --- | --- |
| Workspace | The developer sandbox and its Slack user membership. |
| Persistent lane | One installed Slack app and credentials, verified app/bot identity, fixture IDs, DM/channel names, and one browser profile. These are provisioned once and reused. |
| Active claim | The operating-system lane lock, visible owner/worktree/source identity, one candidate process, and exclusive use of that lane's browser profile. |
| Fresh run | SQLite state, capture state, scratch workspace, provider/session mappings, Monologue seen IDs, logs, readiness receipt, and evidence under `/var/lib/slack-concierge-sandbox/lanes/lane-N/runs/<run-id>/`. |

`reload` restarts the selected worktree inside the same run and preserves that
run's state. `release` closes the run. The next claim creates a new run ID and
new state directories; there is no destructive reset or state reuse.

The four lane locks are the ownership authority. Owner JSON makes the current
owner visible but does not replace the lock. Do not delete a lock file, owner
file, run directory, Chromium `Singleton*` file, or another agent's process to
recover a lane.

## Normal feature loop

### 1. Preflight

Work from the implementation's isolated Git worktree. Run the smallest relevant
local test first, then inspect lane availability:

```bash
bot/scripts/sandbox-lane-control.sh status
```

Each occupied entry identifies its owner, requester, label, worktree, source
commit and dirty-tree digest, run ID, generation, candidate, lane app, fixtures,
browser profile, and run paths. A free entry may retain `stale_owner` metadata
from a completed process; a free lock is still free.

Before claiming, choose the focused Slack behavior and nearest regression
surface. Do not run the full cross-feature suite for an ordinary change. Use a
unique run/case marker in every Slack input and follow exact message, event,
file, turn, and session identities rather than recency or matching text.

### 2. Claim any lane and wait for readiness

From the worktree being tested:

```bash
bot/scripts/sandbox-lane-control.sh claim \
  --owner "<agent-or-thread-identity>" \
  --requester "<request-or-task-identity>" \
  --label "<short-feature-and-case>" \
  --worktree "$PWD"
```

The ordinary command stays attached to the caller. If all four lanes are busy,
it emits one JSON `waiting` record with every current owner, keeps trying the
four non-blocking locks, and continues automatically on the first released
lane. This is an in-process wait, not a durable queue, scheduler, dispatcher, or
service. Cancel a wait with `SIGINT` or `SIGTERM`; cancellation does not disturb
an occupied lane. `--no-wait` is available only for a diagnostic caller that
intentionally wants exit status 10 instead.

On acquisition, the controller validates regular, non-symlinked lane
configuration and exact provisioned identities, records the worktree commit and
dirty digest, starts the candidate, and waits up to the readiness deadline. It
prints the final `running` JSON only after the candidate's receipt proves the
expected process, run, lane, API team, app, bot user, and bot identities. Retain
that record: its `lane`, `run_id`, `lane_fixtures`, and `paths` are the control
and evidence inputs for the rest of the test.

If startup fails, the lane is freed and the failed run's `candidate.log`,
`supervisor.log`, and metadata remain available. Do not claim readiness from an
active PID or a nearby Slack response.

### 3. Exercise only the changed behavior

Send the smallest real Slack input that proves the changed behavior and its
important negative, failure, or idempotency case. Stay within the claimed lane's
app DM or its `core`, `project`, and `capture` fixture IDs from
`lane_fixtures`; never derive channel IDs from names or use another lane's
fixtures.

Join the exact path end to end:

```text
lane app + source conversation + message_ts/root_ts
or stable capture event_id / file_id / note_id
  -> durable input claim
  -> exact provider session and turn
  -> exact Slack response/artifact/canonical projection
  -> terminal outcome and run-owned drain
```

The sandbox runtime refuses the production Slack configuration, verifies the
authenticated API team/app/bot against provisioned lane identity, and keeps its
state and scratch workspace inside the active run. It does not own production
deployment ingress/repair/reactions, Codex Remote observation, production
project cutover, or the production capture queue.

The controller currently reserves a lane-local capture port and private token
but reports `reserved_capture.active: false`. It deliberately does not export
the capture queue URL/token opt-in unless a run-local capture sibling is
actually launched and healthy. Do not describe a direct Slack post or an
inactive reservation as end-to-end Pebble/capture proof.

The reusable typed-turn case is:

```bash
cd bot
bun run tests/sandbox/runner.ts execute typed-turn \
  --lane lane-<N> \
  --run-id <exact-controller-run-id> \
  --apply
```

It posts one run-marked request that makes the real provider inspect three
run-scoped project files and present their roles in a standard Markdown table.
Before accepting completion, the case must observe a
non-starting `Thinking`/activity task with whole-turn elapsed time in the exact
new thread, prove that the exact thread's durable
`agents.sessions.setStatus(processing)` projection was delivered at the same
running boundary, and capture the progress message through the claimed lane's
authenticated browser profile. There is no test sleep or product delay: if the
real turn finishes before that surface can be observed, the case fails instead
of manufacturing a passing state.

The delivered `processing` projection and the client-rendered native controls
are separate acceptance surfaces. The former proves that Concierge established
the Agent-session lifecycle Slack requires for its loading UX and Stop control;
it does not prove that a particular Slack client rendered either control. On
2026-08-27, an authenticated Slack Web developer-sandbox run showed the live
`Thinking · <elapsed>` task card but neither the native working pill nor the Stop
button, while the exact `processing` projection was delivered. Record that as a
client-surface absence, not an app/API failure. If native control rendering or a
real Stop click is in scope, use the narrow official-client manual boundary
below until Slack Web exposes the control; keep the exact API/session evidence
and official-client screenshot or event receipt together.

The terminal proof then requires all of these surfaces from that same turn:

- the same progress-message timestamp terminalized with a current activity task
  titled `Work complete · <provider elapsed>`;
- a separate final bot reply beginning with `TL;DR:` and containing the unique
  case marker exactly once, with the requested file-role table rendered as
  native Slack content rather than visible pipe syntax;
- the original user root updated with `Concierge TL;DR` and the exact cumulative
  summary; and
- authenticated terminal thread screenshot/accessibility/geometry evidence
  that visibly contains the Work complete state, final TL;DR, and root TL;DR.

Missing any surface fails the case. It still requires the exact lane app event,
durable input/turn/provider/delivery identity, exactly one input, turn, and
delivered response, and zero unsettled run owners. The evidence manifest records
the exact source, branch, dirty digest, source identity, and controller
generation; the adapter stops if source or generation changes during the case.
Sandbox Slack idempotency keys include the exact run ID. Fresh run databases
restart local turn counters, so an unscoped `turn:1:*` key would cause Slack to
deduplicate a new run against an old run's message. Production keys are unchanged.

### 4. Reload while iterating

After editing the claimed worktree, restart its candidate without changing the
lane or run:

```bash
bot/scripts/sandbox-lane-control.sh reload \
  --lane <1-4> \
  --run-id <exact-run-id>
```

The controller drains the old generation, records the worktree's new commit and
dirty digest, removes the old readiness receipt, starts the next generation,
and returns only after the new receipt is valid. Existing run databases,
workspace, logs, and evidence remain in place so a focused multi-turn test can
continue.

When isolation from the earlier attempt is required, do not delete state. Close
the lane browser session, release the exact run, and claim again. The new claim
is the supported `fresh` operation.

### 5. Drain, close the browser, and release

Before release, prove the affected run has no unsettled input, turn, projection,
artifact, capture, or provider work. Retain exact receipts and the relevant
logs/evidence. Then close only the claimed lane's browser session as described
below and release the guarded lane/run pair:

```bash
bot/scripts/sandbox-lane-control.sh release \
  --lane <1-4> \
  --run-id <exact-run-id> \
  --timeout 30
```

The selected live case's explicit zero-unsettled assertion is the durable-work
proof and must be captured before release. The returned `released` JSON proves
that the exact supervisor exited and its OS lock became free; it is not a
database-settlement receipt. If the command times out, the lane remains owned
by that run; do not announce it as free or start a second candidate. Inspect its
exact candidate/supervisor logs and retry the guarded release after the owner
settles. Confirm final state with `status`.

In an execution harness that cleans up descendant processes when a command
returns, keep that command session alive after the claim output (for example,
run the claim followed by `exec tail -f /dev/null` in the same shell), perform
the test from another command session, release the exact run first, and only
then terminate the keepalive. This is process lifetime containment in the
calling harness; it is not another lane owner, service, or scheduler.

Sandbox messages and run directories are retained for attribution and
diagnosis. Cleanup means draining the candidate, closing the lane browser
session, releasing the lock, and leaving no run-owned work—not deleting Slack
history, evidence, credentials, fixtures, profiles, or state to manufacture a
clean result.

## Browser ownership and visual evidence

Slack Web authentication is persistent, but a live browser profile is an
exclusive resource. Browser ownership is under the same claim as the lane's
Socket Mode candidate:

- `slack-admin` with profile
  `/root/.local/state/concierge-sandbox/browser/admin` is the dedicated attended
  administration surface. It is for Slack Developer Program, OAuth/install,
  and app-token work only. Feature agents never use it.
- Each lane's `lane_fixtures.browser.namespace` and
  `lane_fixtures.browser.profile_path` identify its feature-test browser. Only
  the active claimant of that lane may use that pair.
- `slack-sandbox` is a stale exploratory session, not an admin or lane identity.
  Never use or reconnect to it. The default browser profile/session is also not
  a lane identity.
- Never concurrently open or share the admin profile, another lane's profile,
  or one profile under two session names. Chromium profile locks and browser
  state do not provide safe multi-agent ownership.

On 2026-08-27 the `slack-admin` profile was empirically authenticated to both
the Slack Developer Program and the sandbox Slack Web client. An owner-only
transient state export from that same user's authenticated admin context was
loaded into each exact lane profile, then zeroed and trash-removed. Closing and
reopening lane 1 proved that its own persistent profile retained authentication.
This establishes the one-time browser bootstrap described below; it does not
permit routine sharing between profiles.

### `agent-browser` invocation contract

The installed `agent-browser` 0.27.0 behavior has been tested against this
workspace. Its command must come first. Every command must repeat the exact
session and profile:

```text
--session <exact-namespace>
--profile <exact-profile-path>
```

Generic examples that put global options before the command are not the working
contract here. Omitting `--profile` on a later command can connect to a separate
`about:blank` context. Repeating the full tuple on a non-launching command is the
safe reconnect to the existing authenticated context. Add `--headed` and
`DISPLAY=:99` only for the attended admin surface or when a claimed feature case
needs an observable headed window. The automated screenshot driver deliberately
uses the same persistent lane profile headlessly; authentication survives clean
close/reopen in either mode.

For the operator, reconnect to the already-live admin browser without opening a
second profile owner:

```bash
DISPLAY=:99 agent-browser snapshot -i \
  --session slack-admin \
  --profile /root/.local/state/concierge-sandbox/browser/admin \
  --headed --json
```

Start the admin browser only after `agent-browser session list` and process
inspection prove that profile is inactive:

```bash
DISPLAY=:99 agent-browser open <admin-url> \
  --session slack-admin \
  --profile /root/.local/state/concierge-sandbox/browser/admin \
  --headed --json
```

For ordinary visual acceptance, use the repository helper rather than assembling
browser commands manually:

```bash
bun run bot/scripts/sandbox-browser.ts probe \
  --lane lane-<N> \
  --run-id <exact-run-id> \
  --permalink <exact-Slack-API-permalink> \
  --channel-id <exact-channel-id> \
  --message-ts <exact-message-ts> \
  --thread-ts <exact-root-ts> \
  --phase terminal \
  --required-text <case-marker> \
  --apply
```

The helper validates the canonical `*.slack.com/archives/...` permalink returned
by Slack, then opens the equivalent exact
`/messages/<channel>/p<message>?thread_ts=<root>&skip_today=1` Web-client route.
Do not navigate the archives permalink first: Slack's launcher interstitial can
time out after a successful handoff. Do not use `--allowed-domains`; Slack Web
loads required assets from its own `slack-edge.com` hosts. The helper still
fails closed after navigation unless the observed route, enterprise ID, channel,
permalink target, required text, visible geometry, and channel header all match.

For a claimed headed lane, substitute the exact namespace/profile from the
claim's `lane_fixtures`. On every snapshot, click, wait, geometry read,
screenshot, or close, put the command first and repeat the same full tuple. For
example:

```bash
DISPLAY=:99 agent-browser snapshot -i \
  --session <lane-browser-namespace> \
  --profile <lane-browser-profile-path> \
  --headed --json

DISPLAY=:99 agent-browser screenshot <run-evidence-dir>/terminal.png \
  --session <lane-browser-namespace> \
  --profile <lane-browser-profile-path> \
  --headed --json

DISPLAY=:99 agent-browser close \
  --session <lane-browser-namespace> \
  --profile <lane-browser-profile-path> \
  --headed --json
```

After a page change, take a new accessibility snapshot before using refs; Slack
rerenders make old refs stale. If reconnect lands on `about:blank`, the session
or profile tuple was wrong—stop without navigating or authenticating it and
reconnect with the exact claimed tuple. If a session is missing while its
profile still has a live Chromium owner, do not launch a replacement or delete
`Singleton*`; keep the lane claimed and escalate that exact profile/process to
the operator. Never run `agent-browser close --all` because it would close the
admin and other agents' lane sessions.

### Evidence requirements

API/state equality is not visual proof. When rendered placement, blocks,
progress, Lists, Canvas, native controls, previews, or layout are in scope, use
the exact Slack permalink and save under the active run's `paths.evidence`:

- a command/result record containing lane, run, source digest, case, exact
  permalink, channel/message/root identity, and assertions;
- accessibility JSON before interaction and after every important state change;
- a screenshot before interaction, at the important transition, and at the
  terminal result when those phases matter; and
- measured geometry for a layout/alignment claim, not an eyeballed screenshot.

For native Agent controls, state explicitly whether the evidence proves the
delivered Agent-session lifecycle, the rendered loading/Stop UI, the resulting
`agent_session_stopped` event, or some combination. Do not substitute one for
another. An accessibility snapshot with no working/Stop control is negative
client evidence even when the durable `processing` projection is delivered.

Keep each permalink beside its screenshot path and SHA-256 in the case result.
Evidence paths must be owner-only, regular files beneath the active run root.
Browser evidence records the observed Web enterprise ID `E0BSKCU61EK`
separately from the run's API team ID
`T0BSKCUULSK`. Do not save tokens, cookies, authorization headers, browser state
exports, raw credential/config files, secret-shaped values, or screenshots of
Slack secret pages. A browser image is evidence only for the exact authenticated
lane/profile and permalink that the run record identifies.

## Persistent provisioning and one-time Slack setup

Ordinary feature work does not create apps, reinstall them, rotate tokens, or
recreate channels. Provisioning runs only for initial setup, credential expiry,
Slack session expiry, or a tracked manifest/install contract change.

The provisioner owns these private roots:

```text
/etc/concierge/sandbox/workspace-configuration.json
/etc/concierge/sandbox/lane-registry.json
/etc/concierge/sandbox/lanes/lane-N/slack.toml
/etc/concierge/sandbox/lanes/lane-N/identity.json
/etc/concierge/sandbox/lanes/lane-N/fixtures.json
/root/.local/state/concierge-sandbox/browser/admin
/root/.local/state/concierge-sandbox/browser/lane-N
```

Secret/config files are root-owned regular files with mode `0600`; each profile
directory and provisioner-owned private directory is `0700`. The controller
rejects symlinked Slack, identity, and fixture files. Do not hand-edit
identities/fixtures, copy one lane bundle into another, or point a lane at
production configuration.

### Initial or manifest-change procedure

1. From a clean, reviewed repository revision, inspect the non-mutating plan:

   ```bash
   bun bot/scripts/sandbox-provision.ts plan
   ```

2. In the exclusively owned `slack-admin` profile, authenticate the Slack
   Developer Program and sandbox workspace, then authorize the workspace-level
   app-configuration credential. Put its version-1 JSON bundle in a root-owned,
   mode-`0600`, regular staging file without exposing it in chat, command-line
   arguments, shell history, logs, or Git. Import it by path:

   ```bash
   bun bot/scripts/sandbox-provision.ts import-workspace-credential \
     --from <owner-only-workspace-credential-json>
   ```

3. Create or reconcile all four manifest-backed lane apps:

   ```bash
   bun bot/scripts/sandbox-provision.ts apply-manifests --apply
   ```

   The result gives each exact app ID, App Settings URL, verified manifest
   digest, and provisioning status. An `ambiguous` creation is a stop condition:
   inspect the sandbox and registry with the admin profile; never retry creation
   and risk a fifth orphan app.

4. For each lane whose status is `authorization_required`, use the returned
   App Settings URL and choose Slack's native **Install App** action. That is the
   authoritative Enterprise-sandbox installation path. In the live setup, the
   OAuth URL returned by the App Manifest API contained an empty redirect URI
   and failed; do not use or repair that generated URL. From the installed
   lane's App Settings, generate one app-level token with `connections:write`.
   Collect the complete lane bundle—app/team IDs, app, bot, and user tokens,
   signing secret, client ID, and client secret—in a root-owned mode-`0600`
   regular staging file. Import it without printing it:

   ```bash
   bun bot/scripts/sandbox-provision.ts import-lane-secrets \
     --lane lane-N \
     --from <owner-only-lane-secret-json>
   ```

   Retain the staging copy only until step 5 verifies the private imported file
   and exact lane identity, then securely dispose of it. Never paste a token
   into a browser-automation command, an environment dump, test evidence, or a
   review artifact.

5. Provision or reconcile the lane's DM, three public channels, verified
   identity, fixture IDs, and persistent browser directory:

   ```bash
   bun bot/scripts/sandbox-provision.ts provision-fixtures \
     --lane lane-N \
     --apply
   ```

   Repeat steps 4–5 for all lanes returned by the manifest operation.

6. Bootstrap the four lane browser profiles once from the authenticated admin
   profile using the exact same Slack user. This is the only permitted
   cross-profile state transfer:

   - prove `slack-admin` is the sole live owner of the admin profile and each
     target lane profile is inactive;
   - create one transient state path in an owner-only directory and save the
     admin context with command-first syntax:

     ```bash
     DISPLAY=:99 agent-browser state save <owner-only-transient-state-file> \
       --session slack-admin \
       --profile /root/.local/state/concierge-sandbox/browser/admin \
       --headed --json
     ```

   - verify the export is a real, non-symlinked, mode-`0600` file, then load it
     serially into each exact inactive lane namespace/profile:

     ```bash
     DISPLAY=:99 agent-browser state load <owner-only-transient-state-file> \
       --session <lane-browser-namespace> \
       --profile <lane-browser-profile-path> \
       --headed --json
     ```

   - open the sandbox in that exact lane profile, verify the same user and Web
     enterprise ID, then close its named session before moving to the next lane;
   - after all four loads, zero the transient file's contents, trash-remove the
     zeroed file, and verify the original path is absent. Never retain it in
     configuration, a run root, evidence, `/tmp`, Git, or another shared path.

   This narrow same-user `admin -> lane` bootstrap does not permit
   `lane -> lane`, `lane -> admin`, stale/default-profile imports, persistent
   shared state files, or copying a Chromium profile directory. After bootstrap,
   every lane profile is used only under its own claim.

7. For each lane, claim current code once, require exact readiness identity,
   open the app DM and all three fixture permalinks in its own profile, save a
   harmless screenshot, drain, close the browser, and release. Lane 1 and the
   `slack-admin` profile have passed clean close/reopen authentication-persistence
   probes. Lane 1 has also passed the complete typed-turn runner/controller,
   dual-identity browser, screenshot, and drain case.

When `slack-app-manifest.json` changes, rerun `apply-manifests --apply` from the
reviewed revision. If Slack reports `permissions_updated`, reauthorize the
affected lanes, import any rotated complete bundles, and reprovision/verify their
fixtures before testing code that depends on the new contract. A normal source
change with no manifest/install drift skips this entire section.

Rotate an expiring workspace configuration credential only through:

```bash
bun bot/scripts/sandbox-provision.ts rotate-workspace-credential --apply
```

The provisioner also rotates it automatically inside manifest apply when it is
within five minutes of expiry. It fails closed if the workspace or user identity
changes.

## Manual boundaries

Ask Tejas or the attended operator only at the exact boundary that automation
cannot reproduce:

| Boundary | Manual input | Agent-owned continuation |
| --- | --- | --- |
| Initial/expired admin authentication | One Slack Developer Program and sandbox-workspace login, including any magic code, CAPTCHA, SSO, or 2FA, in the exclusively owned `slack-admin` profile. This was the only human setup input in the live provisioning. | Native App Settings installation, app-token generation, imports, fixtures, the transient same-user lane bootstrap, identity proof, and all ordinary feature tests. |
| Device-native behavior | One physical Pebble event only when Pebble/device delivery itself changed; one official Slack-client voice message only when native voice metadata/transcription/rendering changed. | Synthetic webhook/known-audio downstream flow, exact receipts, deduplication, provider response, and drain. |
| Client surface absent from Slack Web, including native Agent loading/Stop UI | Perform only the minimum official-client view or Stop click needed for the named claim, and retain its screenshot or exact event receipt. | Delivered Agent-session lifecycle, exact turn/event ownership, cancellation behavior, and all remaining browser assertions. |

New installs, changed permissions, app-level tokens, and lane browser
authentication are agent-owned while the admin profile remains authenticated.
If a lane session expires, repeat only the explicit same-user transient bootstrap;
ask for another attended login only if Slack has also expired or challenged the
admin session.

After provisioning and lane-profile authentication, ordinary typed turns,
historical-root replies, steering, files, known audio, synthetic capture,
Monologue fixtures, TODO/List/Canvas projection, browser screenshots, identity
joins, and drains should not require Tejas. If the necessary lane-local adapter
or capture sibling is not yet implemented, report that software boundary; do
not turn it into repeated human testing.

## Failure and reporting

Stop the focused case on the first ambiguous write, wrong API team/app/bot
identity, wrong Web enterprise identity, browser/profile mismatch, visual
assertion failure, or unsettled drain. Preserve the exact run, receipts, logs,
screenshots, and source digest. Keep the lane claimed while diagnosing or reload
the same run after a fix. If the safe state cannot be proved, close only that
lane's browser session and release only after its candidate drains; never widen
recovery into another lane or production.

The final implementation report states:

- tested commit and dirty-tree digest;
- lane/run and exact focused cases/regression bundle;
- API team, Web enterprise, Slack message, provider, projection, file/event,
  and drain identities;
- screenshot/accessibility/geometry paths for visual claims;
- automated and genuinely manual boundaries exercised;
- anything still unverified; and
- browser close plus lane release proof.

Sandbox proof supports confidence before push. It does not prove production
credentials, destination IDs, public ingress/TLS, systemd activation, or a
production-only policy. Use [live Slack integration acceptance](LIVE-ACCEPTANCE.md)
later only for the smallest changed production boundary that the sandbox cannot
establish.
