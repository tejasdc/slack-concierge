# Live Slack integration acceptance

Use this runbook when a Slack Concierge change crosses a deployed Slack,
provider, capture, projection, or service boundary that local tests cannot fully
prove. Select only the changed boundary and its concrete regression surface; do
not replay the inbox-to-DM cutover's full acceptance matrix for an ordinary
change.

This is a later, user-initiated acceptance procedure. It does not change normal
deployment ownership: an implementation turn commits and pushes, the detached
worker owns rollout and repair, and no provider turn waits for or wakes after its
own deployment. A later acceptance turn begins only after rollout success is
visible or the exact durable deployment run has been read.

## Completion claims

Keep these states distinct:

| Claim | Minimum proof |
| --- | --- |
| `implemented` | The exact commit contains the requested change; required checks and proportionate review passed. |
| `pushed` / `integrated` | That commit is an ancestor of `origin/main`, not merely a task branch. |
| `deployed` / `rollout verified` | A successful deployment run proves a runtime containing the commit, service/capture health, and released gates. An attributable 🚀 is the normal Slack-visible signal. |
| `live-verified` | The deployed commit was established first, then the changed behavior passed through the smallest real production boundary with exact receipts. |
| `done` | Every requested acceptance criterion reached its required claim level; any truly manual boundary was either exercised or reported as outstanding. |

A rollout reaction proves deployment provenance and health, not arbitrary feature
behavior. An implementation turn may accurately report “implemented and pushed;
automated rollout owns deployment.” It must not call integration work deployed,
live-verified, or unqualifiedly done without the corresponding evidence.

## Choose the acceptance slice

Before any production write, record:

- the changed user-visible behavior and the first real boundary fixtures do not
  cover;
- one positive input and one negative, failure, or idempotency check;
- the smallest visible footprint, expected outcome, and exact identities to
  retain;
- the rollback boundary and state that must survive rollback;
- any client/device behavior that the probe will not establish.

Use the existing review-depth matrix once. Live proof is not an additional
review lane. A bounded reversible production probe should answer an observable
runtime question instead of triggering more speculative review rounds. It does
not waive required review at an authentication, secret, destructive-data, or
hard-to-reverse boundary.

Prefer focused fixtures for combinatorial parsing, classification, error, and
recovery cases. Use production for the final contract that depends on installed
entrypoints, real credentials, provider APIs, Slack behavior, systemd, or a join
between owners.

## Automated and manual boundaries

| Surface | Smallest useful live proof | Manual input only when this is in scope |
| --- | --- | --- |
| Typed input, roots, routing, and provider identity | Post through the installed user-token helper; join its exact message/root receipt to the input claim, turn, provider session, response, and intended route/capture. | Subjective response quality or client rendering. |
| Steering | Start one bounded harmless turn, send timed user-token replies while it is active, and verify each message identity, FIFO order, provider acknowledgement, reaction, and root. | Nothing for routing correctness. |
| Files | Upload through the installed helper and compare the source and destination file identities, sizes, hashes, share timestamps, and permalink. | Client-only preview/rendering. |
| Pebble/capture ingress | Send a uniquely identified authenticated multipart request to the real endpoint; join accepted event → Slack message → Concierge claim/turn → outcome, then repeat the stable event once and require exactly one Slack delivery. | The physical Pebble, phone configuration, or Pebble transcription only when that upstream changed. |
| Monologue | Fixtures prove formatting, Slack request identity, failure handling, and repeat-poll deduplication; production service/timer state, invocation, journal, destination, and seen-set preservation are agent-readable. | Create one fresh real note only when the Monologue CLI/API upstream itself must be proved; the installed CLI cannot create one. |
| Ordinary audio | Upload a known audio file to exercise Slack download, local transcription fallback, provider input, and response. | Use the official Slack client once only when native voice-message metadata or Slack-generated transcription is the changed boundary. |
| TODO/List/Canvas | Compare the canonical Git/file source with authenticated API identity, content, state, and participant access. A temporary TODO may run through add/edit/complete/remove when projection mutation changed. | Pixel layout, client caching, or another client-only presentation claim. |
| Deployment health | Read the detached worker's exact deployment run, runtime SHA, invocation/release, health, and released gates. | Changed feature behavior; deployment health alone is not live acceptance. |

Do not describe a synthetic webhook as a physical Pebble test, an ordinary audio
upload as native Slack voice, or API content equality as visual client proof.
Ask Tejas for input only at the exact client/device boundary that remains, say
what to send, and continue every subsequent receipt and deduplication check
without him.

## Execute the live proof

### 1. Establish deployed provenance

Before testing behavior, record the source commit and prove that the running
artifact contains it. For Concierge, use the durable deployment run and its
runtime SHA, service invocation, immutable release when applicable, functional
health, and released provider/capture gates. Do not infer deployment from a push,
an active service, or a nearby 🚀 belonging to another turn.

### 2. Send the minimum exact inputs

Use one inert, uniquely labeled input per changed boundary. Keep related checks
in one thread unless independent roots or cross-root identity are the behavior
under test. Do not create fake project jobs, execute real TODOs, or touch a real
work thread unless that exact thread behavior is required.

Follow stable identity rather than recency or text similarity:

```text
source conversation + message_ts + root_ts
or stable capture event_id / Monologue note_id / file_id
  -> durable accept and claim
  -> provider session and turn/start
  -> exact destination message, reply, file, or canonical record
  -> visible terminal outcome
```

Use helper-returned timestamps, file IDs, and permalinks. Never construct a
Slack URL, select the newest message, or infer a thread from matching text.

### 3. Prove the negative or idempotent case immediately

Examples:

- submit the same capture event identity twice and require one persisted event
  and one Slack delivery;
- require the next Monologue poll to post nothing while preserving every prior
  seen ID;
- require an unknown Slack timestamp to fail before writing rather than falling
  back to a nearby root;
- require a correction to resume the established destination root;
- after an ambiguous receipt read, use only the helper's exact read-only recovery
  command and never repost the write.

“No duplicate was noticed” is not proof. Count outcomes joined to the stable
source identity.

### 4. Classify every write

Respect the helper's delivery states:

- `not_sent`: no Slack write occurred; fix and rerun deliberately;
- `unknown`: Slack may have accepted the write; recover by exact identity and do
  not repeat it;
- `confirmed`: Slack accepted the write even if a later permalink/read failed;
  do not repeat it.

For capture and poller sources, an accepted event keeps its destination and
deduplication identity. Rollback may redirect future intake; it must not rewrite
accepted rows, clear a seen set, or replay delivered work to manufacture success.

### 5. Drain the affected path end to end

After the probes settle, query each changed owner for authoritative unsettled
work. A capture queue reporting `delivered` is not an end-to-end drain. Join each
accepted event through Slack delivery, Concierge claim, provider turn/start, and
visible or canonical outcome. Include relevant queued/parked inputs, live/stale
turns, steering preparation, artifacts, status projections, poller invocation,
and deduplication state.

Limit an ordinary drain to the affected sources, sessions, and destinations. A
retirement or destination migration additionally checks predecessor intake and
uses a before/after accepted-input count as a race guard.

## Failure and rollback

Stop widening the test on the first failed or ambiguous required acceptance.
Preserve the exact input and receipts; adjacent successful checks cannot upgrade
the failed surface.

If the task already authorizes rollback, restore only the changed future-facing
code or configuration through Git and let the normal push-driven deployment
owner roll it out. Preserve accepted captures, Slack/provider history, session
identities, files, canonical notes, receipts, and deduplication state. Deployment
failure itself remains owned by last-known-good restoration and trusted-root
repair; an acceptance agent must not compete with it.

If rollback would mutate user data, accepted destinations, provider/session
identity, or another boundary not already authorized, report the failed
acceptance and exact safe state instead of improvising.

## Production-noise discipline

Exercise ordinary feature behavior in the [reusable Slack
sandbox](SANDBOX-TESTING.md) before push. Use this production procedure only for
the smallest changed boundary that sandbox identities, ingress, service
activation, or client parity cannot establish.

For any required production probe:

- warn once before a test that will create visible Slack traffic;
- use the fewest messages and roots that prove the changed behavior;
- retain exact receipts outside the messages before considering cleanup;
- do not auto-delete test messages, replies, reactions, or files—deletion is
  per-message, actor-specific, non-atomic, and not proven to retract Activity,
  Threads, notifications, provider history, or durable Concierge state;
- do not promote sandbox evidence into a production-only claim involving
  credentials, destination IDs, public ingress/TLS, systemd activation, or a
  production policy the sandbox does not share.

This runbook does not create a workspace, channel, credential, service,
scheduler, deployment wake, or deletion mechanism.

## Acceptance report

Report only evidence relevant to the changed slice:

- source commit and deployed/runtime proof;
- exact source and downstream identities/receipts;
- positive outcome and negative/idempotent proof;
- affected-path drain result;
- cleanup performed or visible test traffic retained;
- exact manual boundary exercised or still outstanding;
- final claim: `live-verified`, `deployed but not live-verified`, or
  `acceptance failed` with rollback/safe-state evidence.
