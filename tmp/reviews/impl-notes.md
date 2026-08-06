# Implementation Notes

## Claude Code provider status (2026-08-06)

Implemented locally:

- `bot/src/claude-code.ts` provides the Claude Code transport abstraction, subprocess transport, stream-json parser, turn runner, and fork runner.
- `bot/src/providers.ts` now uses the real Claude Code provider instead of the stub.
- `bot/src/index.ts` routes top-level `@claude-code` and configured distinct Claude bot mentions to provider `claude-code`, while existing threads remain bound to their original provider.
- `bot/tests/claude-code.test.ts` covers recorded Claude stream-json, tool-use, auth-error, plain-text, args, fork, and routing samples.

Verified on AX41:

- `which claude` -> `/usr/bin/claude`
- `claude --version` -> `2.1.222 (Claude Code)`
- `claude --print --verbose --output-format stream-json "reply with just: PONG"` works as root without bypass flags.
- `--resume <session-id>` reuses the same session UUID.
- `--resume <session-id> --fork-session` returns a new session UUID.
- Root has `~/.claude/.credentials.json`; output reports `apiKeySource: "none"`.

Important runtime detail:

- AX41 rejects `--dangerously-skip-permissions` and `--permission-mode bypassPermissions` under root with `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`. The provider intentionally does not pass bypass flags.

Blocked:

- Deploy/restart/Slack verification is blocked from this sandbox. Direct one-off SSH commands sometimes work, but `rsync`, `scp`, SSH stdin transfer, and chunked append transfer all failed before connecting with `Operation not permitted`.
- Local commit is expected to remain blocked because `.git` is readable but not writable in the permission profile.

## AX41 transfer blocked by sandbox

Plain SSH command execution to `root@95.217.119.40` works, but every non-interactive file transfer attempt from this Codex sandbox failed before reaching SSH:

- `rsync -a --delete --exclude node_modules --exclude .git --exclude tmp --exclude .claude ...`
- `scp ...`
- `ssh ... 'cat > /tmp/slack-concierge-deploy.tgz' < archive`
- base64 payload transfer over a non-interactive SSH command

An interactive SSH session did accept typed commands, but using that to paste source files would be direct remote editing instead of deploying the Mac source tree. I stopped before doing that.

Impact: the Mac source has the implementation and local tests pass, but `/root/workspace/slack-concierge/` on AX41 was not updated and the live SQLite migrations were not executed.

## Local git commit blocked by read-only .git

`git status` and diffs are readable, but `git add` failed with:

`fatal: Unable to create '/Users/tejasdc/workspace/slack-concierge/.git/index.lock': Operation not permitted`

The workspace permission profile allows reading `.git` but not writing it, so I could not create the requested local commit from this session.

## Codex fork CLI mismatch

The requirement text says `codex exec fork` exists, but AX41 currently reports `codex exec` subcommands as only `resume`, `review`, and `help`. Top-level `codex fork` exists. The implementation tries `codex exec fork` first so it will work if the expected CLI arrives, then falls back to top-level `codex fork`; this still needs live validation because top-level fork does not expose `--json` in the installed help.

## Auth refresh pty flow stubbed

`/auth-refresh <provider>` is registered and responds, but the pty URL/code exchange is not implemented. It needs a persisted `auth_flows` table and a Slack thread reply handler to pipe the code into the waiting process without in-memory state.

## Monologue and journalmaxx stubs only

`systemd/monologue-poll.*` and `systemd/journalmaxx-ingest.service` are explicit stubs. I did not port the Monologue cursor logic or journalmaxx ingest because those are larger requirements and the review called out data-loss risks that need careful handling.
