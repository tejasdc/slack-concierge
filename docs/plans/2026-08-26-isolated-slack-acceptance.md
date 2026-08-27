---
title: "Agent-owned Slack sandbox testing"
type: design
status: validation-in-progress
date: 2026-08-26
owner: operator
---

# Agent-owned Slack sandbox testing

## Outcome

Give every implementation agent access to four permanently installed, ready-to-claim
Slack test lanes in the existing `Concierge Sandbox` developer sandbox. An agent
uses any free lane while it is building a feature, selects the focused live cases
and related regression bundles that match the change, inspects the real rendered
Slack UI, captures screenshot evidence, fixes failures, and pushes only after it
has high confidence in its work.

The Slack workspace and four cloned app installations are persistent. Agents do
**not** reinstall an app for each change. The production deployment worker does **not**
run a full sandbox suite and is not the normal place where feature defects are
found. Production deployment retains its existing runtime and health proof; the
implementing agent owns behavioral confidence before push.

The [sandbox runbook](../runbooks/SANDBOX-TESTING.md) is the current operating
authority for sandbox work. The [live-acceptance runbook](../runbooks/LIVE-ACCEPTANCE.md)
remains the production procedure. This dated document records the approved
requirements and empirical validation history; untested cases remain explicitly
provisional.

## Correct development loop

```text
agent edits in its isolated worktree
  -> targeted local test
  -> acquire any free sandbox lane
  -> run that worktree's code against that lane's persistent sandbox app
  -> send focused real Slack inputs
  -> inspect API/state receipts and rendered Slack screenshots
  -> fix and repeat until the relevant behavior is convincing
  -> run the related reusable regression bundle once
  -> release the sandbox lane
  -> review at the proportionate level
  -> commit and push
  -> normal production deployment and health proof
```

The full cross-feature suite is an explicit, occasional test operation. It is not
run for every code change or every production deployment. A feature agent uses
judgment to test the changed behavior, its nearest ownership boundary, and the
small set of related regressions that would plausibly break.

## Requirements

### Persistent installations, on-demand test sessions

- Keep one Slack Developer Program sandbox, already created at
  `concierge--sandbox.enterprise.slack.com` and reported as archiving in 362 days
  on 2026-08-26.
- Create four sandbox-only Concierge apps from the tracked
  `slack-app-manifest.json`; install each once and update/reinstall them only when
  the manifest or Slack installation contract changes. Ordinary code changes and
  worktree switches never create, reinstall, or reauthorize an app.
- Keep four sandbox lane configurations ready on the server. Each lane owns its
  persistent Slack credentials, Slack fixture IDs, and browser namespace. Each
  claim receives a fresh run root for SQLite state, scratch projects and notes,
  capture state, provider-session mappings, Monologue seen IDs, logs, and evidence.
- Starting a test session selects an agent worktree's current code. It does not
  recreate the workspace, app, credentials, channels, or browser login.
- Stopping a test session drains that candidate, preserves its run-owned state and
  evidence for diagnosis, and returns the persistent lane installation to a known
  idle state. A later claimant never reuses that prior run state.
- Do not add any production deployment trigger, repair workflow, scheduler, or
  recurring full-suite execution for sandbox testing.

### Four reusable lanes across worktrees

All worktrees draw from the same fixed four-lane pool. A lane is not permanently
assigned to a worktree: it is a reusable native Slack isolation boundary with one
app installation, one fixture set, and one browser namespace. Runtime and evidence
roots belong to claims, not lanes.
Creating an app or channel set per worktree would add unbounded drift and Slack
clutter; four fixed lanes permit four different unmerged revisions to run at once.

Only one candidate runtime may own a particular lane app's Socket Mode connection
at a time. Slack does not promise deterministic delivery when multiple connections
consume one app's events, so each lane uses a non-blocking OS process lock. The
runner attempts the four locks in order and takes the first free lane. If all four
are occupied it reports their human-readable owners, remains attached to the
requesting agent, and acquires the first lane that becomes free. It does not create
a durable queue, scheduler, coordinator service, or dispatcher.

The wait belongs only to the on-demand claim process. Each wait pass attempts the
same four non-blocking lock files; work grows only with the number of currently
waiting agents, healthy idle services perform no work, and the loop stops on lane
acquisition or caller cancellation. A waiting feature agent therefore resumes its
own test automatically instead of failing and losing the development loop.

Each lane has the same fixture topology:

```text
Concierge Sandbox Lane N app DM
#concierge-lane-N-core
#concierge-lane-N-project
#concierge-lane-N-capture
```

The lane app joins only its own fixture channels. App DMs are natively distinct
because each clone has its own bot identity. The same authenticated sandbox user
may use all lanes; browser automation uses a lane-specific session or tab so
concurrent visual tests do not navigate one another's evidence surface.

Each sandbox run records:

- selected lane and sandbox app ID;
- worktree path and branch;
- current commit plus a digest identifying uncommitted changes;
- requesting agent/thread identity when available;
- selected test cases and fixtures;
- start/end time and final drain result; and
- exact evidence and screenshot paths.

Runs use unique labels and Slack thread roots so retained messages remain
attributable. Runtime state that would contaminate another case—especially the
shared-Claude DM anchor, provider UUIDs, capture events, and Monologue seen
state—lives only in that claim's fresh run root. Fixed Slack channel, List, Canvas,
DM, and browser identities remain reusable inside the lane.

### Agents have eyes

- Maintain authenticated browser state for all four lanes on the service host.
  Authentication is a one-time attended setup and is repeated only when Slack
  expires or revokes the underlying user session.
- Agents must be able to open exact sandbox message permalinks, inspect the
  accessibility tree and rendered client, press supported native controls, and
  save screenshots without Tejas operating the browser.
- Visual acceptance captures the relevant message/thread before interaction,
  after the important state transition, and at the terminal result. The test
  records the message permalink and screenshot path together.
- API equality is not visual proof. Content blocks, progress cards, Lists,
  Canvas, agent views, thread placement, native Stop, and layout changes require
  browser evidence when they are in scope.
- Browser automation selects the same lane as the candidate runtime and uses that
  lane's DM, fixture channels, and browser session or tab.
- Native mobile-only behavior remains honest. If Slack web cannot originate or
  render a boundary faithfully, record that limitation and request the minimum
  real-device input rather than calling an API fixture equivalent.

### Focused reusable tests, not one giant mandatory suite

Keep sandbox tests beside the existing focused tests, grouped by user-visible
risk surface rather than by rollout or historical incident. The intended shape
is:

```text
bot/tests/sandbox/
  cases/          one independently runnable live behavior
  fixtures/       inert text, file, audio, capture, List, and Canvas inputs
  bundles/        small named collections for related regression surfaces
  support/        exact receipt, drain, browser, and evidence helpers
```

The final names may change after the first real run, but these ownership rules do
not:

- A case sends the smallest real input that proves one behavior and its negative
  or idempotent counterpart.
- A bundle composes existing cases; it does not duplicate their implementation.
- Each case is independently runnable during iteration.
- Every case follows stable Slack/event/file/turn/session IDs. It never chooses
  “the newest message” or treats approximate text as identity.
- Test messages remain in the sandbox. Deletion is not a prerequisite, evidence
  strategy, or attention-isolation mechanism.
- A full suite is a named explicit bundle for periodic broad confidence or major
  cross-cutting work. It is never an automatic per-deploy tax.

Initial focused case families:

| Family | Representative live cases | Nearby regression bundle |
| --- | --- | --- |
| Input/session | typed root, historical-root continuation, provider identity, shared-Claude anchor | input classification + provider session ownership |
| Steering | immediate and later guidance, exact user-message identity, FIFO order, post-guidance response placement | steering + queued-turn ownership |
| Progress/UI | commentary, activity cards, plan, continuation pages, terminal reply, cumulative TL;DR, native Stop | progress projection + multi-turn overwrite prevention + screenshots |
| Files/audio | ordinary file, image, known audio, transcript, provider input, artifact output | attachment lifetime + audio fallback + visual preview |
| Capture/Pebble | authenticated multipart fixture, accepted destination, repeated event ID | capture state + one-delivery deduplication |
| Monologue | fake upstream note, formatting, sandbox destination, seen ID, repeated poll | poller contract + seen-set preservation; exact remote-box code is tested by its owning repository |
| TODO/List/Canvas | fixture TODO changes, List projection, committed fixture `AGENTS.md`, Canvas projection/access | projection watcher + browser content/layout |
| Recovery/drain | unknown receipt, parked case, restart where relevant, no unsettled work in affected owners | exact affected-surface recovery bundle |

### Evidence and completion claims

The implementing agent's final report identifies:

- the worktree revision/digest tested;
- the focused sandbox cases and regression bundle selected, with why they cover
  the change;
- exact Slack receipts and durable state assertions;
- visual screenshot evidence for client-facing behavior;
- automated and manual boundaries actually exercised;
- anything not verified; and
- whether the sandbox was drained and released.

The agent may say the feature is ready to push only when the evidence matches the
requested acceptance criteria. Sandbox proof does not by itself prove production
credentials, destination IDs, public proxy/TLS, systemd activation, or a
production-only policy. Normal deployment health proves the installed artifact;
one minimum production smoke remains appropriate only when such a production
boundary changed.

## What Tejas should and should not have to do

One-time attended setup may require Tejas or a laptop browser agent to:

- authenticate the Slack Developer Program account;
- authorize one workspace-level app configuration credential, after which the
  lane provisioner creates and updates the four manifest-backed clones;
- install/authorize the four lane apps and obtain their Socket Mode app tokens,
  using CLI or authenticated browser automation wherever Slack permits it;
- persist each lane's credentials through the documented root-owned configuration
  command without placing them in Git, shell history, or chat; and
- authenticate the persistent server browser profile through Slack's magic-code
  flow.

This is not repeated per worktree or feature.

After setup, Tejas is not required for lane allocation, worktree switching, typed
posts, steering, ordinary files and audio, synthetic Pebble requests, Monologue
fixtures, duplicate submissions,
Lists, Canvas, browser screenshots, receipt joins, or drains. A real device is
requested only when the changed behavior genuinely belongs to that device or a
client surface the server browser cannot reproduce.

## Source-supported decisions

Slack describes developer sandboxes as distinct Enterprise-feature test
environments with no connection to another workspace's data or settings. Their
lifecycle and Free-plan message/file retention mean Slack is a test surface, not
the permanent evidence database. See [Developer
sandboxes](https://docs.slack.dev/tools/developer-sandboxes/) and [Manage Slack
developer sandboxes](https://slack.com/help/articles/27390391126803-Manage-Slack-developer-sandboxes).

Slack explicitly identifies development clones of production apps as a manifest
use case. The clone receives its own installation and credentials; see
[Configuring apps with app
manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/).

A muted production channel cannot satisfy the attention requirement: Slack says
muted conversations may still produce mention/DM badges and bold Threads after
replies. Activity offers inclusion filters and custom views, not a documented
permanent exclusion for one test channel. See [Mute channels and
DMs](https://slack.com/help/articles/204411433-Mute-channels-and-direct-messages-Mute-channels-and-direct-messages)
and [Activity](https://slack.com/help/articles/19693583638803-Get-your-work-done-from-the-Activity-view).

Deletion is author-bound and per-message, and Slack does not promise that it
retracts already delivered Activity, Threads, notification, cache, or retention
effects. See [`chat.delete`](https://docs.slack.dev/reference/methods/chat.delete/)
and [Slack data exports](https://slack.com/help/articles/220556107-How-to-read-Slack-data-exports).

The production app should not be distributed to the sandbox. The current
Concierge runtime and database are single-workspace, while Slack's distributed
app model requires workspace-specific OAuth installations and authorization
routing. A cloned app plus separate state is smaller and safer. Four clones remain
within the sandbox workspace's documented limit of 20 integrations while leaving
room for other apps and workflows. See [App
distribution](https://docs.slack.dev/app-management/distribution/), [Bolt
authorization](https://docs.slack.dev/tools/bolt-js/concepts/authorization/), and
[Developer sandboxes](https://docs.slack.dev/tools/developer-sandboxes/).

## Rejected designs

- **Reinstall for every change:** the four sandbox apps and credentials are
  persistent; only candidate code and run state change.
- **One sandbox or app per worktree:** unnecessary unbounded workspace/app/channel
  drift. A fixed four-lane pool bounds configuration while supporting real overlap.
- **Multiple candidate Socket Mode processes on one app:** event delivery would not
  have one deterministic owner. Separate lane apps provide Slack-native routing.
- **One app plus a custom ingress dispatcher:** supports arbitrary concurrency but
  adds a new event-routing subsystem when four native app identities solve the
  observed operating profile.
- **Full sandbox suite in every production deployment:** slow, expensive, and too
  late for the implementing agent to learn from the result.
- **Production canary as routine testing:** smaller implementation but fails the
  attention-isolation requirement.
- **Delete-after testing:** cleanup cannot undo the interruption and adds its own
  ambiguous side effects.
- **One multi-workspace production app:** requires OAuth/token/schema routing that
  the personal single-workspace runtime does not need.
- **Manual visual acceptance by default:** the persistent sandbox browser is the
  agent's client-side observation surface.

## Validation plan before finalizing mechanics

The sandbox itself is the design review for uncertain Slack behavior. Before
building elaborate orchestration:

1. Programmatically create as much of the four-lane app pool as Slack permits,
   then use authenticated browser automation for any required installation or
   app-token boundary. Record the exact remaining human-authentication boundary.
2. Authenticate persistent server browser state and prove two lane sessions can
   open the workspace, follow exact permalinks, inspect the UI, and save screenshots
   without navigating one another's tabs.
3. Start current `main` in one lane with sandbox-only config/state and disable every
   production-only owner. Prove the production workspace and capture queue receive
   no sandbox traffic.
4. Exercise one typed message, provider response, thread continuation, and visual
   screenshot end to end.
5. Start two different worktree revisions in two lanes, exercise both DMs and
   fixture channels concurrently, and prove each Slack receipt and response belongs
   to the selected lane app and state database.
6. Exercise five attempted owners and prove four acquire distinct lanes while the
   fifth reports the four current owners and remains waiting; release any lane and
   prove the fifth acquires it and continues automatically.
7. Use what is observed to finalize the smallest runtime/profile, lane, evidence,
   and test-helper implementation. Do not invent retry or retention machinery
   before a real failure demonstrates the need.

## Verified

- The `Concierge Sandbox` developer sandbox already exists; the operator reports
  its URL and current archive countdown.
- Four separately installed manifest-backed apps, DMs, fixed channel fixture
  sets, owner-only credentials, and persistent lane browser profiles are live.
  Ordinary worktree changes do not reinstall them.
- The controller has run four simultaneous candidates with distinct app IDs,
  candidate PIDs, state/workspace roots, and OS lane locks. A fifth claim emitted
  its current-owner `waiting` receipt, stayed alive, and automatically acquired
  lane 2 after its prior owner released it.
- Same-run reload preserved run identity and source while advancing the candidate
  generation; release drained and freed the lane; the next claim reused the
  persistent installation with a fresh run root.
- The admin browser and lane 1 browser retained authentication after clean
  close/reopen using their exact persistent profiles. Authentication was
  bootstrapped to all four lane profiles without copying profile directories or
  retaining the transient browser-state export.
- The complete typed-turn case passed against clean commit
  `4264a8b9462b280f635cd3ba6929f0782ed31ecc`: one Slack user input, exact lane
  app event, one durable provider session/turn, one delivered reply, an
  authenticated Web-client screenshot/accessibility/geometry proof, and zero
  unsettled run owners. The evidence joins API team `T0BSKCUULSK` to Web
  enterprise client `E0BSKCU61EK` and records exact source/generation provenance.
- Live trials established the required Slack-specific contracts: the installer
  user must be an explicit fixture-channel member; `chat.getPermalink` and
  `conversations.replies` use query requests; deterministic Slack idempotency
  keys are run-scoped; the browser validates API permalinks but opens the exact
  `/messages/...` handoff directly; and Slack Web cannot use a narrow
  `--allowed-domains` list because its own CDN is required.
- Official Slack documentation supports the sandbox, manifest-backed app clones,
  workspace isolation, 20-integration workspace limit, and feature-parity direction.
- Slack documents that multiple Socket Mode connections for one app receive
  payloads without a predictable distribution pattern; separate app identities
  are therefore the minimum native boundary for different concurrent revisions.
- Current Concierge source uses one Slack config/team, channel-scoped state, and
  one Socket Mode app; it needs a separate sandbox runtime/state rather than
  multi-workspace changes.
- Current startup also owns production capture delivery, deployment ingress,
  deployment reactions/repair, and Codex Remote observation. A sandbox runtime
  must not start those production-only owners.
- The installed server browser automation renders Slack, inspects accessibility
  state, follows exact message routes, measures geometry, and saves screenshots
  from persistent authenticated profiles.

## Not verified

- Reusable live cases beyond typed-turn—historical-root replies, steering,
  attachments/audio, synthetic capture/Monologue deduplication, TODO/List, and
  Canvas—still need their bounded adapters and live evidence.
- Native Slack voice creation/rendering and physical Pebble delivery remain real
  device/client boundaries. Their downstream known-audio and webhook flows can
  still be automated separately.
- The lane-local capture port/token is reserved but deliberately inactive; no
  run-local capture sibling has yet proved synthetic Pebble or Monologue ingress.
- Agent view, Lists, Canvas, and other native visual controls have not yet been
  exercised across the sandbox case catalog.
- Feature-agent use from multiple different dirty/unmerged worktrees and the one
  bounded production deployment/smoke are the next validation steps.
- Fully unattended first-time Slack app authorization remains bounded by Slack's
  login/SSO challenges. The persistent installed baseline eliminates that step
  from ordinary feature iteration.

## Confidence limits

- **98%:** the app/workspace installation should be persistent and agent test
  sessions should be on demand; no reinstall belongs in the iteration loop.
- **95%:** four fixed manifest-identical app lanes are the smallest deterministic
  way to run four different worktree revisions concurrently without a dispatcher.
- **95%:** visual Slack web evidence should be agent-owned through a persistent
  browser rather than defaulting to Tejas.
- **90%:** focused cases plus related bundles are a better cadence than a full
  multi-minute suite on every change or deployment.
- **75%:** the current full runtime can be cleanly separated into a sandbox profile
  without a broad redesign. The real sandbox trial should determine the exact
  seam before implementation is considered settled.
