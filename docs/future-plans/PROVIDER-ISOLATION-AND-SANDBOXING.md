# Provider isolation and sandboxing

## Goal

Reduce the impact of a compromised or misbehaving Codex/Claude process by
running Concierge and each provider under deliberate Linux identities and by
limiting provider filesystem, credential, process, mount, and network access.

## Candidate sequence

1. Inventory provider session state, credentials, workspaces, and continuity
   requirements without moving anything.
2. Introduce a narrow provider broker that owns start, steer, inspect, and stop
   operations and reliably reaps each provider process tree.
3. Create non-root provider identities and obtain fresh supported credentials;
   never copy live OAuth refresh-token files between identities.
4. Migrate only provider state proven necessary for Slack thread continuity.
5. Add user/mount/PID namespace isolation and an executable-specific AppArmor
   profile after the broker is stable.
6. Cut over provider by provider with continuity and rollback tests.

## Why it is separate

This changes every provider path, credential, session, child process, and deploy
assumption. It is a worthwhile security project, but contributes nothing to
accepting a Pebble transcript safely.

The complete exploratory mechanics and threat analysis remain in
`2026-08-19-platform-hardening-source-design.md`.
