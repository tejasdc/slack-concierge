---
title: Provider isolation and sandboxing
status: future-proposal
owner: Slack Concierge
---

# Provider isolation and sandboxing

Scope note: the
[deployment repair-agent design](../plans/2026-08-24-deployment-repair-agent.md)
borrows this proposal's lifecycle-broker, continuity, and OS-isolation concepts
but supersedes its credential-ownership and re-authentication provisions for
repair/review sessions only. Those sessions must use the existing provider
credential/session authority through a trusted adapter that keeps credential
bytes inaccessible to model tools. The broader ordinary-provider proposal below
otherwise remains a future project.

This is a self-contained future project. Reading the archived platform-hardening
exploration is not required to understand, review, or implement it.

## Outcome

Limit the damage a compromised or malfunctioning Codex or Claude process can
cause. Concierge, the provider launcher, and provider processes should have
separate Linux identities, separate credentials, narrowly declared filesystem
access, and a launcher that owns and reaps the complete provider process tree.

This project must preserve existing Slack thread continuity and the ability to
start, resume, steer, fork, stop, and recover provider sessions.

## Scope

- Run the Concierge bot as a fixed non-root identity.
- Run provider workloads as a different fixed non-root identity.
- Put provider lifecycle operations behind one authenticated local broker.
- Restrict each provider run to its declared workspace and additional paths.
- Move mutable runtime state from `/root` into service-owned `/var/lib` paths.
- Obtain fresh, supported provider credentials for the target identity.
- Preserve or explicitly archive every existing session mapping.
- Add user, mount, and PID namespace isolation with an executable-specific
  AppArmor policy after the broker works without sandboxing.

This project does not redesign capture ingress, Monologue, backups, Slack
routing, or provider APIs.

## Target ownership model

| Surface | Owner | Allowed access |
| --- | --- | --- |
| Slack bot process and main state | `concierge-bot` | Slack bot credentials, main database, configured project/vault paths |
| Provider broker socket and lifecycle ledger | broker service | Start, steer, fork, inspect, stop, and reap operations only |
| Codex/Claude processes and provider state | `concierge-provider` | Current run's workspace policy and that provider's credentials/state |
| Backup, restore, and privileged migration controls | root control plane | Unavailable to the bot and providers during ordinary runtime |

The broker is the only provider control endpoint. It authenticates the calling
bot process, derives all paths and flags from durable server-side policy, binds
each request to a turn/run identity, and records the exact host PID, boot ID,
start ticks, process group, and namespace identities before reporting success.
Provider processes never receive the broker socket or Slack credentials.

## Phased plan

### 1. Inventory and continuity contract

- Enumerate every provider credential, config file, plugin/skill dependency,
  session store, referenced session UUID, workspace, and additional path.
- Classify each item as required runtime state, reproducible cache, credential,
  or disposable output.
- Define a no-tool/no-write continuity probe for every referenced session.
- Record which sessions can be migrated and which require an explicit reset.

No files or identities change during this phase.

### 2. Introduce the provider broker

- Move start, resume, steer, fork, inspect, stop, and recovery behind one local
  Unix-domain socket protocol.
- Authenticate the bot peer with kernel credentials and bind messages to the
  durable turn/run record.
- Make the broker own termination escalation and reaping for the entire child
  process tree.
- Cut over provider calls without changing Linux users yet.

This phase proves lifecycle ownership before permission changes make failures
harder to diagnose.

### 3. Migrate runtime ownership

- Create the non-root bot and provider identities.
- Copy the main database into a bot-owned `/var/lib` location using a stopped,
  journaled migration with a retained rollback image.
- Generate a closed filesystem-authority inventory from registered project,
  vault, and additional paths.
- Grant only the ACLs required by that inventory; do not grant general `/root`
  visibility or access to sibling projects and credentials.
- Probe create, rename, append, fsync, Git worktree/index, and cross-project deny
  behavior under the real target UIDs.

### 4. Re-authenticate and migrate provider state

- Obtain fresh credentials under the target provider identity using supported
  login flows. Never copy live OAuth refresh-token files from root.
- Copy only the proven session/config closure, with source and destination
  manifests and digests.
- Run the continuity probe for every migrated UUID before changing routing.
- Archive unprovable sessions with a clear reset notice instead of silently
  pointing Slack threads at unrelated provider history.

### 5. Add the per-run sandbox

- Introduce a small, non-setuid launcher that creates the user, mount, and PID
  namespaces and acts as the namespace's PID 1/reaper.
- Bind only the declared workspace paths into the run.
- Hide host `/proc`, broker sockets, Slack credentials, backup/restore paths,
  other projects, and unrelated provider state.
- Install an executable-specific AppArmor profile granting only the namespace
  operations required by that launcher.
- Fail before provider exec if the profile or namespace prerequisites are
  absent. Do not weaken the host-wide AppArmor user-namespace restriction.

### 6. Cut over one provider at a time

- Start with one provider while retaining the old launcher as a rollback path.
- Verify fresh sessions, resumed sessions, steering, forking, cancellation,
  crash recovery, and deployment drains.
- Make the credential/state migration forward-only only after continuity and
  rollback evidence is recorded.
- Repeat for the second provider after the first is stable.

## Acceptance criteria

- Concierge and providers run as their intended non-root UIDs.
- The bot can use only registered project/vault paths; each provider can use
  only the current run's workspace policy.
- Providers cannot read Slack, Monologue, capture, backup, restore, or other
  provider credentials through direct paths or `/proc` aliases.
- Wrong-UID and provider-child broker clients are rejected.
- Disconnects and crashes kill and reap the complete provider process tree.
- Provider runs have distinct user, mount, and PID namespaces with no host PID
  view and a functioning inner PID 1.
- Every pre-cutover Slack thread has either proven session continuity or an
  explicit archived/reset disposition.
- A failed cutover can restore the recorded unit, database, ACL, and launcher
  state without inventing credentials or session mappings.

## Decisions required before promotion

- Whether bot and provider filesystem writes should use ACLs, bind mounts, or
  a narrower project service API for newly created projects.
- Which provider should migrate first.
- Which historical session age/value justifies continuity migration.
- What rollback boundary applies after new credentials refresh or new provider
  state is written.

## Historical provenance

This proposal was extracted from the superseded 2026-08-19 platform-hardening
exploration, now stored under `docs/archive/`. That archive is evidence of prior
reasoning, not required reading and not implementation authority.
