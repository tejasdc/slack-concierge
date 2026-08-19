---
title: "Pebble webhook with Concierge-owned Slack delivery"
type: implementation
status: approved
date: 2026-08-19
---

# Pebble webhook with Concierge-owned Slack delivery

## Outcome

Ship a testable transcript-only Pebble webhook at
`https://capture.tejas.nyc/pebble`. The public capture service durably accepts
authenticated requests without possessing a Slack credential. The trusted
Concierge process dequeues captures over a private authenticated, idempotent
loopback API,
posts them to the configured Slack inbox with its existing user token, and lets
the existing Slack message router process them normally.

The historical authenticated `/audio` route remains compatible.

## Scope boundary

This plan does not change Monologue, provider identities, provider launching,
AppArmor, backup/restore, project scaffolding, Slack metadata scopes, Lists,
Canvas, or Git effects. Those ideas are preserved under `docs/future-plans/`.

## Invariants

- The Internet-facing `concierge-capture` process receives only route secrets,
  the internal queue credential, route configuration, and access to its own
  capture state/audio directories. It receives no Slack or provider token.
- `concierge-capture` remains the only routine owner of the capture SQLite
  connection. Concierge uses an authenticated API on a separate loopback port;
  the public HTTP listener does not expose those routes.
- A valid transcript is committed before the webhook returns `202`. Stable
  event IDs and Slack `client_msg_id` values make sender and Slack retries
  idempotent.
- Only the trusted Concierge process calls Slack for queued captures. It uses
  the already configured `user_token`, making the resulting Slack message a
  normal user-authored input to the existing router.
- Queue claims and acknowledgements are owner-bound. After a bot crash, the
  queue may recover a `sending` row only after proving the prior PID, boot ID,
  and process start identity dead.
- Concierge creates one stable, unguessable claim ID before requesting work.
  If an HTTP response is lost after the queue commits, repeating that claim or
  acknowledgement returns the already committed result rather than stranding
  a live-owned row or repeating the Slack post.
- Route path, adapter, authentication, body limit, destination channel, and
  rendering label remain configuration data.
- Ambiguous or transient Slack outcomes retain the capture for safe retry;
  permanent contract/auth failures are parked for inspection.
- Deploy holds capture delivery while replacing either service and releases it
  only after ingress and Concierge pass their existing functional health gates.

## Implementation

- [x] Remove the Slack credential from capture route parsing, the ingress
      systemd unit, the installer, and deployment checks.
- [x] Keep ingress acceptance and `/audio` storage in the existing adapter and
      destination interfaces, but stop the ingress from calling Slack.
- [x] Add a private authenticated loopback queue API with an atomic
      claim-next operation plus delivered, retry, and park acknowledgements.
      Persist the stable claim ID with its exact owner; make all four operations
      idempotent after a committed-but-lost HTTP response.
- [x] Add a Concierge-owned polling delivery worker using the existing Slack
      `user_token`; integrate startup recovery and graceful drain. An
      unrecoverable post-claim worker failure terminates Concierge so the exact
      owner can become provably dead rather than leaving a live-owned lease.
- [x] Preserve deterministic event and Slack client-message identities and add
      owner-conditional queue transitions.
- [x] Add the `capture.tejas.nyc` Cloudflare Worker custom domain with an exact
      `/pebble` and `/health` allowlist and the existing Caddy origin.
- [x] Remove the undeployed dedicated-capture Slack manifest and document that
      no additional Slack installation or OAuth scope is required.
- [x] Update architecture, operations, configuration, and historical status
      documents to describe the new ownership boundary and test URL.

## Verification

- [x] Focused ingress tests prove auth, transcript-only limits, deduplication,
      persistence-before-acknowledgement, `/audio` compatibility, and absence
      of a Slack credential from ingress configuration.
- [x] Focused queue API tests prove loopback/auth separation, owner-bound
      claim/ack transitions, dead-owner recovery, deployment-gate blocking, and
      committed-but-dropped responses for claim, delivered, retry, and park.
- [x] Focused Concierge worker tests prove existing-user-token delivery,
      deterministic `client_msg_id`, retries, parking, and clean shutdown.
- [x] Worker tests prove only `/pebble` and `/health` proxy and no request body
      or authorization value is logged or persisted.
- [x] Before emitting `concierge_bot_online`, Concierge must authenticate the
      private queue, validate the configured Slack `user_token`, connect its
      Slack listener, and start the capture worker. Deployment tests prove a
      wrong queue credential, missing/invalid user token, or worker startup
      failure prevents that current-invocation readiness marker and leaves
      delivery held. The queue secret is the only new credential shared by the
      two services; ingress still has route secrets and no Slack/provider token.
- [x] Run the complete Bun test suite after focused tests pass (341 pass,
      0 fail on the final 2026-08-19 gate).
- [x] Obtain an independent explicit `SHIP` verdict on the implementation diff.

## Rollout

1. Leave the Cloudflare custom domain undeployed until the origin is healthy;
   do not add a maintenance state machine for the one-time cutover.
2. Use the existing stopped-service bootstrap to replace the legacy `/audio`
   receiver without interrupting an active upload.
3. Generate the Pebble route secret and internal queue secret without
   overwriting either on later deploys.
4. Start and probe ingress, hold capture delivery, restart and probe Concierge,
   then release the exact deployment tokens.
5. Enable/probe `https://capture.tejas.nyc/health`; send one authenticated test
   transcript and verify one visible message plus normal router admission.
6. Configure Pebble for transcription-only delivery using its route bearer.

Production deployment and the real Pebble test occur only after the reviewed
implementation is committed and pushed.

## Review record

Approved after three bounded reviews. The lifecycle review's initial `NO-GO`
added idempotent claim/ack recovery and made queue/user-token/worker readiness a
deployment gate. The simplicity review's initial direct-SQLite alternative was
withdrawn after permission probes proved a root-first database can lock the
`concierge-capture` service out. All three superseding verdicts are `GO`.

The independent implementation review initially returned `NO-SHIP` because
the online marker could precede the worker's first queue operation. Worker
startup now awaits one authenticated claim cycle, a behavioral regression test
proves an initial claim failure cannot reach the deployment-release point, and
the superseding implementation verdict is `SHIP`.
