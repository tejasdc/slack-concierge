# Claude Code Provider Implementation

Date: 2026-08-06

## Implemented

- Added `bot/src/claude-code.ts` with a transport abstraction, subprocess transport, argument builder, stream-json parser, turn runner, and fork runner.
- Replaced the Claude provider stub in `bot/src/providers.ts` with the real Claude Code implementation.
- Added top-level-only Claude routing for `@claude-code` and optional configured `claude_code_bot_user_id` / `CLAUDE_CODE_BOT_USER_ID` mentions.
- Preserved thread/provider immutability: existing sessions still route by the persisted provider row, and mid-thread provider switches are logged as ignored.
- Added `bot/tests/claude-code.test.ts` covering stream-json assistant text, tool-use counting, JSON-array auth errors, plain-text fallback, Claude args, fork args, and provider mention routing.

## Verified

- Local `bun test` passes: 15 tests across 4 files.
- AX41 has Claude Code installed: `/usr/bin/claude`, version `2.1.222`.
- AX41 has root Claude credentials present at `~/.claude/.credentials.json`; CLI output reports `apiKeySource: "none"`, consistent with subscription/OAuth auth rather than API keys.
- AX41 `claude --print --verbose --output-format stream-json "reply with just: PONG"` returned assistant text `PONG` and session UUID `c0f2ec4e-5099-4dd2-9960-03b102478f80`.
- AX41 `--resume <uuid>` returned the same UUID and assistant text `RESUMED`.
- AX41 `--resume <uuid> --fork-session` returned a new UUID and assistant text `FORKED`.
- Tool-use event shape was verified with Bash: assistant content includes `{ "type": "tool_use", "name": "Bash" }`, followed by a user `tool_result`, then final assistant text.

## Blockers

- Deploy/restart/Slack round-trip verification is blocked by the current sandbox: direct SSH commands work intermittently, but `rsync`, `scp`, SSH stdin transfer, and chunked append transfer were rejected before connecting with `Operation not permitted`.
- Local git commit is likely blocked by the same repository permission issue already recorded in `tmp/reviews/impl-notes.md`: `.git` is readable but not writable in this managed sandbox.

## Not Deployed

The Mac source tree contains the implementation and tests pass locally. AX41 live code was not updated because file transfer from this sandbox is blocked.
