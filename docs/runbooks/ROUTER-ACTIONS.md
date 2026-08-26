# Router action helper

`systemd/router-actions.sh` is installed by Concierge's normal deployment at `/root/.local/bin/router-actions.sh`. All posting commands use the same backing script, `bot/scripts/router-post.ts`, and the existing `toMrkdwn` converter. There is no router-side posting library or token option.

## Commands

| Command | Effect | Credential |
| --- | --- | --- |
| `post <channel> [--file <path> ...] -- <text>` | New top-level input; optional files | User |
| `resume <channel> <thread-ts> [--file <path> ...] -- <text>` | Input in an existing thread; optional files | User |
| `upload <channel> <thread-ts> --file <path> [--file <path> ...] [-- <text>]` | File input in an existing thread; requires a file | User |
| `audit <channel> <thread-ts> -- <text>` | Audit/clarification reply, without triggering another agent | Bot |
| `resolve-upload <channel> [--thread <thread-ts>] --file-id <id> [--file-id <id> ...]` | Read-only file-share receipt recovery | User |
| `permalink <channel> <message-ts>` | Read-only link lookup for an already known exact timestamp | User |

Channels accept managed names (with or without `#`) or Slack conversation IDs. Every thread argument is a **root** timestamp, preserved as a string. Threaded posting verbs reject a missing/malformed timestamp; `post` rejects `--thread` rather than silently creating a new root. Files can be supplied without text. Existing `post <channel> "text"` and `--file=<path>` syntax still work. Use `--` before text that begins with an option.

`react`, `todo-add`, `channel-id`, and `channels-list` retain their existing contracts. `help` lists the posting and recovery commands; `list-add` remains retired.

## Success and failure

All posting verbs emit exactly one JSON object on stdout, only after both identity and permalink are known:

```json
{"channel":"C123ABC","ts":"1756000002.000003","permalink":"https://example.slack.com/archives/C123ABC/p1756000002000003?thread_ts=1756000000.000001&cid=C123ABC","thread_ts":"1756000000.000001","file_ids":["F123"]}
```

`thread_ts` is null for a new root (or a standalone `permalink` lookup, which does not infer thread context); `file_ids` is empty for text. Use the returned `permalink` in the audit text. Do not construct a URL or infer a timestamp. `audit` converts normal Markdown links and bold text through the same converter as routed input.

Text posts take their timestamp from `chat.postMessage`. Uploads reserve each file, POST bytes to its upload URL without forwarding a Slack token, and complete all files once with the requested channel, optional thread, and converted initial comment. The helper then reads each exact file ID with `files.info`, selects only its share in the requested channel/thread, and requires one common timestamp across all files. Neither `conversations.history` nor `conversations.replies` is used. Finally `chat.getPermalink` supplies the message URL, not the file-download URL.

Failures produce JSON on stderr and a nonzero exit (2 for invalid arguments, 1 for runtime failures); stdout contains no partial success. Runtime errors after setup carry `channel`, `thread_ts`, `file_ids`, and a `delivery` classification:

- `not_sent`: no message/share write was attempted; upload reservations may exist but were not completed.
- `unknown`: a write may have been accepted, or a read-only upload lookup has not proven a share. Do not repeat the post.
- `confirmed`: Slack accepted the post/share, even if identity metadata or the permalink read failed. Do not repeat the post.

When safe recovery is possible, `recover` contains the exact argument array to pass to `router-actions.sh`, for example `['resolve-upload', 'C123ABC', '--thread', '1756000000.000001', '--file-id', 'F123']`. This command only reads Slack. A permalink failure after a confirmed text post includes its exact `ts` and `['permalink', channel, ts]`. A transport failure before a text timestamp is returned cannot produce an exact receipt and has no automatic recovery command; inspect that uncertain outcome rather than reposting blindly.

There are no automatic write retries, history scans, periodic polling, new credentials, or persistent state. Each upload lookup performs at most one `files.info` per supplied file and one permalink read; cost grows only with files in that invocation, not thread history. If share metadata is still unavailable, invoke the supplied read-only recovery command later. Missing scopes, invalid API responses, ambiguous shares, and disagreeing file timestamps all fail closed.

## Caller migration

The old `post` stdout was a bare timestamp or comma-separated file IDs. It is now always JSON on success. Change consumers to parse `ts` and `permalink`, and remove any recency lookup, URL construction, or raw posting/upload calls. Direct `bun scripts/router-post.ts <channel> ...` invocations remain supported with the same new JSON output.

The separate `slack-inbox` project's instruction file currently describes the retired output and tells the router to bypass this helper for resumes/audits. Replace that command guidance with the table above when adopting this helper; its repository is not modified by this change. In particular, replace raw user-token `chat.postMessage` with `resume`, threaded upload scripts with `upload` (or `resume --file`), and raw bot-token audit posts with `audit`. The audit line's content remains the router's decision; transport and identity do not.

Configuration continues to come from `/root/.config/concierge/slack.toml` (`user_token` / `bot_token`) and the Concierge channel registry. `CONCIERGE_SLACK_CONFIG` and `CONCIERGE_STATE_DB` support isolated runs, matching `router-todo.ts`; `CONCIERGE_ROUTER_BOT_DIR` selects a worktree's backing scripts for tests. No Slack scope changes are required: the manifest already grants user `chat:write`, `files:write`, and `files:read`.

## Verification and provider references

Run `cd bot && bun test tests/router-post.test.ts tests/router-todo.test.ts`. Fixtures exercise stale thread views, delayed/mismatched share metadata, public/private shares, multi-file identity, token selection, Markdown conversion, thread parameters, read-only recovery, ambiguous write failures, and shell/CLI output. They do not post into live Slack.

Provider contracts: [external upload reservation and byte POST](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/), [single upload completion and root thread targeting](https://docs.slack.dev/reference/methods/files.completeUploadExternal/), [file share identity metadata](https://docs.slack.dev/reference/methods/files.info/), and [message permalink lookup](https://docs.slack.dev/reference/methods/chat.getPermalink/).
