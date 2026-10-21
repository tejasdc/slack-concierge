---
failure: A side question asked about a session on the Mac came back with no answer, and the side copy still had the Mac's MCP tools (including a vault delete) loaded.
date: 2026-10-13
fix_commits: [2ceba826]
cause_status: confirmed
---

# Side questions on the Mac answered nothing

## What was seen

Hours after side questions shipped (88065e42, 2026-10-13 01:11 ET), a side question about a Claude session on Tejas's
Mac returned no answer: the copy ran, but the panel got only the plain failure sentence instead of Claude's reply. The
same check found that the side copy, meant to be unable to act, still started every MCP server configured on the Mac,
one of which can delete files in his Obsidian vault. No harmful MCP action was observed; that part is an exposure
found during the check, not damage.

## Cause

`claudeAnswer` in `bot/src/session-asides.ts` ran `claude -p --resume … --fork-session --no-session-persistence
--tools "" --output-format json` and did `JSON.parse(result.stdout)` expecting one result object. Where the CLI's
settings make JSON output verbose (the Mac), `--output-format json` prints the whole event list as a JSON array, so
`parsed` was an array without `result`, the check `typeof parsed.result!=='string'` failed, and the answer was
discarded as a failure. Separately, `--tools ""` removes only built-in tools; MCP servers from the user's
configuration still load unless `--strict-mcp-config` is given with no MCP config.

## Fix

2ceba826: the parser takes the JSON from the first `[` or `{`, and when it is an array uses the last event with
`type==='result'`; a single object is used as before. The command adds `--strict-mcp-config` (with no MCP config), so
the copy has neither built-in tools nor MCP servers.

## Acceptance scenario

- **Seed:** A Claude session with a transcript, and a stub `claude` executable (via
  `CONCIERGE_CLAUDE_CODE_EXECUTABLE`) that prints a verbose JSON event array ending in
  `{"type":"result","result":"answer text"}` and records its arguments.
- **Action:** Ask a side question about that session through `POST /sessions/v1/sessions/<id>/asides`.
- **Expected:** The answer is "answer text"; the recorded arguments include `--tools ""` and `--strict-mcp-config`
  and no `--mcp-config`. A single-object output still works.
- **Replayable offline:** yes (stub CLI; the real verbose-output setting is a Mac Claude Code setting)
