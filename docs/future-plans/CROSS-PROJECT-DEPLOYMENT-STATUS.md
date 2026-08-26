# Cross-project deployment status

Status: future direction only. Slack Concierge currently tracks and deploys
only its own repository. This document does not authorize a generalized
deployment platform or any runtime change beyond the current Concierge fix.

## Outcome

An agent working from any managed Slack project—an existing channel and
repository such as Gator or one created later—should receive the same automatic
status projection after it commits and pushes:

- 📦 on that completed agent turn's first delivered final response when its
  commit enters a deployment;
- 🛠️ when autonomous repair owns that deployment failure;
- 🚀 only after the project's live runtime proves the deployed commit; and
- 🛑 when repair parks for operator attention.

The agent contract remains only “commit and push.” Agents do not enroll their
turn, request a wake, invoke a deployment command, poll status, or learn a
project-specific reaction protocol. Projects without an automatic deployment
do not show deployment reactions.

## What the current design intentionally preserves

The Concierge-only implementation keeps the boundaries needed for later reuse
without building the reusable platform now:

1. A source event identifies `repository`, `ref`, `after`, and provider delivery
   ID rather than assuming a process-global commit.
2. Durable desired state is keyed by a deployment target, even though the only
   current target is Slack Concierge `main`.
3. Commit provenance resolves independently from deployment state.
4. Slack target resolution requires a completed turn and the first delivered
   final-response receipt; it is not based on thread recency or the user request.
5. State projection consumes lifecycle transitions (`deploying`, `repairing`,
   `deployed`, `parked`) rather than shell-log text.
6. Push acceptance, deployment scheduling, project-specific execution, runtime
   proof, and Slack projection remain separable contracts.

Those seams are sufficient future direction. The current change should not add
a registry abstraction, generic adapter framework, second daemon, or new
credential solely in anticipation of this plan.

## Minimum exportable model

The existing managed-project registry should become the single inventory. Each
deployable project would add a deployment binding with these facts:

| Field | Purpose |
| --- | --- |
| project identity | Existing registry row and Slack channel/thread ownership |
| repository and tracked ref | Exact source events accepted for this project |
| code root | Provenance lookup and project operations |
| deployment target ID | Durable namespace for desired state and runs |
| deploy adapter | Existing project-owned command or supervisor entrypoint |
| runtime proof adapter | Project-specific proof that the exact commit is live |
| repair policy | Whether Concierge self-repair applies and which trusted workflow owns it |
| reaction policy | Enabled only when commit-to-runtime proof exists |

The registry stores bindings, not executable shell snippets. A deploy adapter
must be a reviewed project-owned entrypoint with a stable result contract. A
web app, systemd service, mobile build, and documentation-only repository do not
share one meaningful deploy command or health proof.

The durable state key becomes `(deployment_target_id, desired_commit)`. A single
repository may have multiple tracked refs or runtime targets, and multiple
projects must never share an unqualified `origin/main`, run ID, reaction row, or
last-known-good release.

## Source-event routing

One GitHub App or organization webhook is preferable once several repositories
need coverage; per-repository webhooks remain an acceptable starting mechanism
for a small personal fleet. Either mechanism must deliver the same normalized
event contract and verify the provider signature before routing.

Routing is exact:

```text
GitHub repository + ref
  → one managed deployment binding
  → monotonic desired commit for that target
  → that target's coalescing worker
```

Unknown repositories and refs are acknowledged or rejected without deployment
work. A source event must never fall back to the Slack channel that happened to
receive it. Live events are sufficient; fleet-wide Git polling and startup
history reconciliation remain unnecessary unless a later product requirement
explicitly asks to recover pushes received during downtime.

When generalized, the deployment webhook should receive a dedicated provider
secret rather than continuing the Concierge-only reuse of `capture_queue`.
Credential distribution follows the executing host's operator repository and
existing systemd credential path.

## Provenance and Slack ownership

Commit trailers continue to carry only opaque turn provenance. Resolution uses
the repository that contains the commit plus the token-to-turn mapping; a token
alone cannot identify a deployment target. The target message remains the
turn's first delivered final response and is eligible only after the turn is
terminal and delivery is recorded.

A commit range may contain work from several turns, channels, or repositories
only when the deployment adapter explicitly declares that source set. Each
resolved turn gets its own durable reaction lifecycle. Unattributed commits
remain deployable and silent. Repair determines causality from actual failure
evidence; provenance proves authorship context, not blame.

## Adoption and creation paths

This feature should plug into the existing channel/project lifecycle rather
than adding a second onboarding system.

For an existing channel and repository:

1. run the existing managed-project adoption/scaffold reconciliation;
2. discover a project-owned deploy and exact-runtime proof entrypoint;
3. review and add one deployment binding to the project registry;
4. install or verify the shared provenance hook through the sanctioned Git
   configuration path;
5. register the repository/ref with the source-event receiver; and
6. run one reversible push-to-proof acceptance test before enabling reactions.

For a new channel, folder, and repository, `/create-channel` and the shared
project scaffold remain the only creation path. They may offer deployment
binding setup after Git origin and hosting exist. Creation must succeed without
a deployment binding, because many projects are not live services. Once bound,
new projects receive the same event, provenance, lifecycle, and projection
contracts automatically; generated `AGENTS.md` does not need feature-specific
instructions.

For an existing registry fleet, a read-only audit should classify projects as
bound, eligible-but-unbound, non-deployable, or ambiguous. Adoption is an
explicit per-project write after the audit; it must not guess commands from
package scripts or add hooks to unrelated repositories automatically.

## Failure and repair ownership

The generalized scheduler routes facts; it does not diagnose failures. Each
target must declare one of three policies:

- verified deploy only: project failure parks and reports evidence;
- Concierge trusted-root repair: current autonomous repair contract applies;
- external owner: an existing project supervisor owns repair and reports state
  transitions back through the same lifecycle contract.

There is still one repair owner per failed run. A coordinator must not compete
with a repair agent or infer “the culprit” before diagnosis. Reaction projection
is downstream of durable state and does not wake feature agents on success.

## Acceptance criteria for a future implementation

- A push in two independently bound repositories routes to the correct target
  without scanning every checkout.
- Each state reaction lands only on the attributable completed agent final
  message in the correct Slack channel and never on the initiating user message.
- A new push received during an active worker pass causes a coalesced follow-up
  pass and is not lost.
- A deployment in one project cannot advance, repair, park, or remove reactions
  owned by another target.
- Existing channels can be adopted without moving their repository or replacing
  their deploy path.
- Newly created projects can opt in through the ordinary scaffold lifecycle;
  projects with no deployment remain unchanged.
- Exact runtime proof, not webhook receipt or command exit alone, is required
  before 🚀.
- The source-event receiver and bot restart without replaying historical Git
  state or requiring agents to resend work.

## Explicit non-goals

- A universal deploy script for every repository.
- Fleet polling, startup Git scans, or a new message queue merely for scale.
- Making every Slack channel deployable.
- Inferring production infrastructure from folder names or package manifests.
- Copying Slack Concierge's immutable-release machinery into projects that
  already have a correct deploy supervisor.
- Global reaction cleanup or rewriting historical status.

The implementation should be promoted from this document only when at least one
second real project is selected and its existing deploy/runtime-proof contract
is known. That concrete project is the evidence needed to choose the smallest
shared interface without inventing a platform around one example.
