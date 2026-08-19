---
title: Monologue delivery receipts
status: future-proposal
owner: Slack Concierge
---

# Monologue delivery receipts

This is a self-contained future project. Reading the archived platform-hardening
exploration is not required to understand, review, or implement it.

## Outcome

Close the current crash window between posting a Monologue transcript to Slack
and recording the source note as seen. Preserve the working user-facing flow:
Monologue remains user-authored, lands in the same Slack inbox, and is handled
by the same router.

The durable receipt—not the seen file—becomes the authority for whether a note
was posted and classified. The seen file remains a crash-safe derived
projection that can be rebuilt without reposting Slack messages.

## Scope

- Stable Monologue source identity based on the provider note ID.
- Persisted posting intent before the Slack API call.
- Persisted Slack timestamp before source classification.
- Explicit ambiguous-send reconciliation and parking.
- Atomic page membership plus source cursor advancement.
- Durable classification before the seen-file projection advances.
- Migration of existing seen notes into no-repost tombstones.
- Startup and restore repair of the seen projection.

This project does not move Monologue into the Pebble capture queue, change its
Slack destination, or change it from user-authored to bot-authored messages.

## Receipt state model

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `pending` | Source note and exact payload snapshot are durable; no Slack call owns it | `sending` |
| `sending` | Exact process owner may call Slack | `posted`, `send_unknown`, `pending` after definite rejection |
| `send_unknown` | Slack outcome is ambiguous | `posted` after affirmative match, `parked_unknown` |
| `posted` | Slack timestamp and exact rendered payload are durable | `classifying` |
| `classifying` | One exact owner coordinates with normal Slack input ownership | `classified`, `parked_unknown` |
| `classified` | Slack/router disposition is durable | terminal; seen projection may advance |
| `legacy_no_repost` | Pre-migration seen note imported without a trustworthy Slack timestamp | terminal; projection repair only |
| `parked_unknown` | Automatic progress is unsafe | explicit audited operator action |

Every nonterminal lease records PID, boot ID, start ticks, and attempt token.
Recovery may adopt it only after proving that exact owner dead.

## Payload and identity contract

- Fetch each note by stable ID and normalize one documented byte-level payload.
- Persist the exact rendered Slack text or its immutable payload hash before
  sending; later code changes cannot silently change a retry's identity.
- Derive a deterministic client/message identity from the stable note ID and
  payload contract version.
- Reject transcripts that exceed the Slack envelope before durable acceptance.
- Page scans commit page membership and the opaque next cursor in one
  transaction. A cursor never advances past a note without a receipt or
  no-repost tombstone.

The earlier exploration proposed a self-describing HMAC suffix and an isolated
verify-only service as recovery evidence for user-authored Slack messages. That
is a candidate mechanism, not a requirement. The promoted plan must first test
whether Slack history plus stable message identity provides sufficient
affirmative evidence; use the HMAC/verifier only if it closes a demonstrated
ambiguity without exposing the Monologue user token or receipt secret.

## Ownership model

- A dedicated non-root Monologue poller owns source enumeration and receipt
  creation/send leases.
- The trusted Concierge process owns classification because it already owns
  Slack input admission and router state.
- One projection worker owns the seen file and applies database revisions using
  temp file, fsync, rename, and parent fsync.
- The Monologue user token remains confined to the poller. Providers, capture
  ingress, and the bot do not gain it.
- Deployment, snapshot, and restore use the existing durable operation gates to
  make every nonterminal receipt nonclaimable before closing admission.

## Phased plan

### 1. Inventory the live contract

- Pin the installed Monologue executable, version, output format, pagination,
  cursor behavior, note-ID stability, and rate limits.
- Record the current timer/service state, seen-file contents, Slack rendering,
  destination, and user-token owner.
- Build fixtures from real CLI responses without mutating the live cursor.

### 2. Add receipt state without changing delivery

- Add the receipt and seen-projection tables.
- Atomically commit page members and cursor transitions.
- Keep the current Slack renderer and destination.
- Add owner-bound state transitions, dead-owner recovery, retry bounds, and
  parking before replacing the legacy poller.

### 3. Migrate the seen boundary

- Inhibit the timer and wait for the exact active poller invocation to finish;
  do not kill it midway through a post.
- Import every seen note as `legacy_no_repost`.
- Audit all discoverable source notes and matching Slack history around the
  boundary. Any unresolved note parks instead of reposting.
- Render and verify the initial database-authoritative seen projection before
  enabling the new poller.

### 4. Cut over posting and classification

- Persist intent, take a send lease, post, and persist the Slack timestamp.
- Reconcile `send_unknown` with affirmative evidence; do not infer non-delivery
  from a missing result or `client_msg_id` alone.
- Let normal Socket input ownership win first. A narrow finalizer may classify
  only the exact unclaimed receipt/timestamp after the competing path has been
  ruled out.
- Commit `classified` before advancing the projection revision.

### 5. Integrate deployment and recovery

- Block deploy/snapshot/restore while receipts are in unsafe states, or adopt
  them through the same exact operation token.
- On startup and after restore, compare the projection digest/revision with the
  database and repair it without reposting.
- Include receipt state in coherent application snapshots only when the
  disaster-recovery project is promoted.

## Acceptance criteria

- A crash before Slack cannot mark a note seen.
- A crash after Slack but before timestamp persistence becomes `send_unknown`,
  never an automatic repost.
- A crash after timestamp persistence resumes classification without a second
  Slack message.
- A crash after classification but before file replacement rebuilds the seen
  projection without reposting.
- Replaying a source page or cursor is idempotent.
- The cursor never skips a note lacking a receipt/tombstone.
- Socket routing and the receipt finalizer cannot both admit the same message.
- Existing seen notes survive migration as no-repost tombstones.
- The poller token or optional receipt secret is unavailable to the bot,
  providers, capture ingress, logs, and backup manifests.
- User-visible Monologue formatting, authorship, destination, and timer cadence
  remain unchanged unless separately approved.

## Decisions required before promotion

- Whether Slack history and stable message identity are sufficient recovery
  evidence or an authenticated receipt suffix is justified.
- The retry/parking policy for ambiguous Slack outcomes.
- How far backward the initial source/Slack audit must scan.
- Whether to ship receipt durability before the broader disaster-recovery
  generation work.

## Historical provenance

This proposal was extracted from the superseded 2026-08-19 platform-hardening
exploration, now stored under `docs/archive/`. That archive is evidence of prior
reasoning, not required reading and not implementation authority.
