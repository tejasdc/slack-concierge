# Codex Runtime Sync Corruption — 2026-08-24

## Impact

The shared Codex App Server lost its expected command-execution-host path during Mac Remote setup. An unnecessary daemon restart interrupted active agents before the disk repair was understood. The replacement App Server was healthy, but its managed on-disk `current` path still mixed malformed and stale content.

## Root Cause

The Mac's bidirectional config sync included the whole `~/.codex` tree and used `rsync --copy-links`. It copied Mac-owned standalone package state onto Linux and materialized symlinks as ordinary files or directories. In particular, `packages/standalone/current` stopped being a release symlink, and the release-level `codex -> bin/codex` link became a regular file. The live Linux App Server had already loaded 0.149.1, while the malformed managed target exposed stale 0.147.0 content.

The response also conflated three transitions: Remote pairing, package repair, and process restart. Pairing failure did not prove the live App Server needed replacement, and disk topology could be repaired without signaling it.

## Repair

The malformed directories were preserved under timestamped recovery paths. The official standalone installer was rerun; its first pass reused polluted 0.149.1 content, so that release was preserved too and a second pass forced a clean download. Verification restored `current` as a release symlink, `current/codex` as `bin/codex`, and the executable `bin/codex-code-mode-host`.

No restart was required for that repair. Linux kept the already-loaded 0.149.1 executable inode alive while the future launch path was replaced. App Server, SSH proxy, and Slack bridge PIDs and start times remained unchanged during the successful repair.

## Prevention

- The laptop sync project now excludes root-level Codex package, app-server, process, browser, alternate-auth, and other runtime roots. Its regression test proves those roots do not transfer while nested portable skill content still does.
- Slack Concierge is the canonical authority for shared App Server startup, update, activation, and recovery. The host-operator repository points here rather than maintaining a second lifecycle narrative.
- The redundant global npm installation was removed after proving no live unit or process used it. The standalone package tree is now the only Codex install channel on the service peer.
- Installation is staged independently from activation. App Server restart requires an explicit Concierge admission boundary and post-restart probe.
- The built-in updater remains disabled because its 60-second graceful turn drain is not equivalent to Concierge's durable admission and long-turn guarantees.
- Version inspection covers the selected CLI, managed target, running server, loaded executable inode, and helper topology rather than trusting one `--version` result.

The specific cross-platform overwrite is regression-tested and should not recur. The ongoing lessons apply to every new machine-local runtime subtree and every lifecycle mechanism that can bypass the owning application's admission gate.

## Superseded follow-up: protected deployment coupling

Repairing the standalone installation moved its `current` candidate from Codex
0.147.0 to 0.149.1. The next unrelated application deployment then failed
before build because the protected control-plane installer derived its expected
worker-runtime digest directly from that mutable host path, while its installed
snapshot still contained 0.147.0. The gate correctly refused an unapproved
protected-runtime change, but normal-deploy candidate selection crossed the
wrong lifecycle boundary.

The protected worker snapshot mitigation was implemented briefly, then retired
on 2026-08-25. It solved the immediate coupling but preserved an unjustified
multi-principal architecture for a personal root-operated server. Current
deployment repair uses the normal standalone Codex installation directly and is
documented in
[trusted-root deployment repair](../architecture/DEPLOYMENT-REPAIR.md). This
section remains only as incident chronology, not current operational guidance.
