# Concierge DM naming and List access

## Scope and operating profile

Concierge is a personal, single-operator application. Tejas approved naming his
new DM workspace `concierge-dm`, retaining the existing TODO projection machinery,
and stopping automatic retries of permanent Slack errors. He explicitly does not
need the placeholder workspace contents or conversation history migrated.

The live DM is `D0BMWUJ3RD5`. A bounded request to `slackLists.access.set` with its
existing List `F0BSA0V9BPZ`, `access_level: read`, and this DM in `channel_ids`
returned `invalid_arguments` with a server validation requirement of
`^[C][A-Z0-9]{2,}$` for `channel_ids/0`. Read-only `conversations.info` identifies
the conversation as `is_im: true` and supplies its participant. The existing List
is private and unshared. Slack documents `user_ids` as the alternative access
recipient in this same API.

## Complete change

- Preserve the existing API and channel behavior. For a DM ID, resolve the
  authenticated bot's `conversations.info` response, require the exact requested
  conversation ID, `is_im: true`, and a valid participant ID, then grant that
  participant read access using `user_ids`. Do not trust the incoming message's
  optional user field as the permission recipient; startup has no such field.
  Persist access as read only after Slack confirms success. Reuse the existing
  List and its authenticated creation identity.
- Keep the shared projection watcher generic. Allow its owner to classify retry
  eligibility; the TODO watcher will reject permanent Slack failures and keep
  retries for temporary failures. Unknown non-Slack/local failures retain the
  current retry behavior. A file event or explicit trigger may retry a corrected
  projection. Do not introduce a scheduler, database table, or polling loop.
- Create a fresh `concierge-dm` scaffold through the existing project-creation
  generator. This is fresh creation, not application of the fleet scaffold
  migration. Do not move, copy, or delete vault files. Update only this DM's
  descriptive name and workspace/vault paths using `replaceManagedProjectMapping`
  in `project-registry.ts`: one atomic SQL statement compares the DM ID and all
  five old mapping fields, rejects another row claiming either destination, and
  changes only those five fields. Require exactly one updated row. Do not call
  the default-bearing `newProject`/`upsertChannel` helpers. Preserve provider settings, session
  identities, List identity, and old files. Rename the existing List and update
  its canonical-file description without changing its identity marker.
- The current turn keeps using its captured old directory and artifact staging
  path. Future admissions read the new registry path. Preserve the old workspace
  throughout this turn. The normal code deployment reinitializes watchers from
  the registry; do not start a second service or restart the Codex daemon.

## Non-goals

No new router, assistant persona, persistent-session policy, global workspace
alias, app rename, Slack channel creation, credential, OAuth scope, history
rewrite, deletion, or general migration framework. Existing channel permissions
must remain unchanged. A separate Canvas behavior change requires concrete
provider evidence, not an assumption that all channel APIs reject DMs.

## Verification and safety

Use a fresh-context high-risk review because this changes access targeting and
live workspace mapping. Review this design before those mutations, then review
the entire diff and test evidence once the implementation is complete.

Focused tests cover unchanged channel payloads, DM participant resolution with
no triggering user, invalid/mismatched metadata with zero permission writes,
failure without a false access marker, reuse without a duplicate List, permanent
failure suppression, transient retry, and retry after a later explicit event.
Mapping tests compare every untouched row field and all session rows, reject
stale inputs and occupied destinations without writes, and exercise reverse CAS.
Run the full existing suite once after implementation, with at most one rerun.

The live mutation must snapshot only the affected registry row, List metadata,
and intended paths. Recheck that the old note files remain generated empty
placeholders and that the new destination is unclaimed. Keep the old files as
rollback material. Do not restore the entire live database to undo a one-row
change. New workspace instruction files are committed locally; no new GitHub
repository is implied by this task.

Apply ordering is fresh scaffold and local commit, verified List read access,
List title/description update, then mapping CAS. Verify Slack metadata by reading
it back before the CAS. If mapping fails, restore only the prior List metadata
(not the correct read grant); leave both directories and the old mapping intact.
If the Slack update is ambiguous, inspect it read-only and stop before mapping.
For rollback after mapping, reverse the exact mapping CAS first, then restore
List metadata. Preserve both directories and all unrelated state throughout.

Verify the corrected access call on the existing List with the actual bot and
participant, plus read-only access from the participant's existing token where
available. Do not claim that subsequent provider-turn resume or deployed retry
behavior was exercised in this turn. Code changes go through Git and the normal
automatic deployment boundary: push, report the evidence, and end the turn;
never wait for deployment or restart services here.

## Investigation evidence

The baseline passed 43 focused tests. The new regression cases reproduced the
missing DM recipient handling and permanent-error loop before the implementation.
A bounded channel-Canvas creation probe on this DM returned
`canvas_creation_failed` without a specific cause. Do not infer a general DM
Canvas restriction from this response or introduce a standalone-Canvas subsystem
in this change. Canvas projection already has no automatic retry loop; retain
its existing behavior and report the unresolved compatibility check explicitly.

## Verification record — 2026-08-26

- Focused projection tests: 55 passed. Mapping/adoption tests: 10 passed.
  Full `bun test` gate: 701 passed, zero failures, across 70 files. Independent
  complete-diff review returned `SHIP` after the guarded mapping correction.
- Fresh scaffold applied at `/root/workspace/concierge-dm`; canonical vault notes
  are `/root/workspace/vault/projects/concierge-dm/notes`. Instructions, symlinks,
  docs, and artifact ignores were committed locally as `5cf1d7c`. The fresh
  repository has no remote; this operation did not create a GitHub repository.
- The exact existing List was repaired using the candidate `ensureChannelList`
  implementation and the authenticated bot. Slack confirmed read access and the
  registry recorded `read`. The participant's existing user token could not see
  the List before (`not_visible`) and could read its metadata after (`visible`).
- List metadata read-back confirmed `Concierge DM todos` and the new canonical
  TODO path. The authenticated identity marker and List ID stayed unchanged.
- The mapping CAS changed only its five name/path fields. Every unrelated
  channel field and all session identities were checked against the prior row;
  old directories remain available to the active turn. No history was migrated.
- Not verified in this turn: a later provider resume from the new directory,
  deployed watcher behavior, or successful DM Canvas creation. These are not
  implied by the live access/mapping proof or the passing code tests.
