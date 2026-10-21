---
failure: After Codex updated itself, a stray Codex server started outside its manager, and every Codex account switch failed until it was replaced.
date: 2026-10-08
fix_commits: [263bd650, b7569e2e, 5728db48, fd60fa19, 108caddb]
cause_status: confirmed
---

# A stray Codex server broke account switching

## What was seen

At 3:53 PM EDT on 2026-10-08 Codex updated itself to 0.162.0. The updater's replacement server quit, and a
0.162.0 listener appeared outside the managed-daemon path. Every Codex account switch then failed, and the
[dispatch incident record](2026-10-08-dispatch-hang-handoff.md) noted "Account switching remains unavailable
until safe managed replacement". (That record owns the updater shutdown itself and its native opt-out.)

## Cause

Confirmed from 263bd650 and b7569e2e. The updater's replacement server exited because the old one still held
the control socket. Five seconds later the Mac Codex app's SSH payload, connecting to the box, started its own
unmanaged server. Account activation (`provider-activation.ts`) works only through the daemon manager, so it
could not restart that server. Activation also counted running Codex turns and then restarted, so a turn
claimed in between could start on a server about to stop.

## Fix

- 263bd650: SSH sessions on the box carry `CODEX_SSH_SKIP_APP_SERVER_BOOT=true` (the payload's own opt-out,
  installed by `install-codex-stop-hook.sh` and checked with `sshd -t`); a Concierge connection that finds the
  socket missing or refusing runs `daemon start` in its own scope, at most every 30 s.
- b7569e2e: activation holds new Codex admission during the restart, counts, and defers if anything runs; at
  the first idle moment the owner replaces an unmanaged server (stop it, keep its socket under a dated name,
  start the managed one) through the same deferred activation. Server only.
- 5728db48, fd60fa19, 108caddb (review rounds on b7569e2e, pushed minutes apart): stop only processes holding the socket's
  inode (following the control-socket link), hold start-when-absent, count lost external turns as running,
  change no account, release no usage-held work, one restart at a time, no retry loop, probe only after the
  killed listener exits, and move a dangling socket link aside.

## Acceptance scenario

- **Seed:** a Codex App Server listening on the control socket but not started by `codex app-server daemon`;
  no Codex turn running.
- **Action:** request a Codex account switch, and open an SSH session to the box.
- **Expected:** the SSH session starts no server; the owner replaces the unmanaged server once idle, keeps the
  old socket under a dated name, the managed daemon answers, and the switch succeeds; with a Codex turn running
  the replacement defers and nothing is killed.
- **Replayable offline:** no (needs the real Codex daemon and socket on the server)
