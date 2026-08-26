# Router action helper

`systemd/router-actions.sh` is installed by Concierge's normal deployment at `/root/.local/bin/router-actions.sh`. All posting commands use the same backing script, `bot/scripts/router-post.ts`, and the existing `toMrkdwn` converter. There is no router-side posting library or token option.

The deployment runner initially installs the wrapper from trusted control/LKG. After health proof and promotion, it refreshes the wrapper from the promoted artifact before recording success. Omitting that refresh leaves the previous release's dispatch table installed even though `--help` reads the newer backing script. Wrapper changes therefore require both shell execution coverage and promotion-install coverage; checking the backing function alone cannot establish entrypoint reachability.

## Commands

| Command | Effect | Credential |
| --- | --- | --- |
| `post <channel> [--file <path> ...] -- <text>` | New top-level input; optional files | User |
| `resume <channel> <thread-ts> [--file <path> ...] -- <text>` | Input in an existing thread; optional files | User |
| `upload <channel> <thread-ts> --file <path> [--file <path> ...] [-- <text>]` | File input in an existing thread; requires a file | User |
| `audit <channel> <trigger-message-ts> -- <text>` | Confirm the triggering message's root, then post the audit/clarification there | Bot |
| `thread-of <channel> <message-ts>` | Confirm exact message identity and return its root in `thread_ts`, with the queried message's `ts` and permalink | User |
| `resolve-upload <channel> [--thread <thread-ts>] --file-id <id> [--file-id <id> ...]` | Read-only file-share receipt recovery | User |
| `permalink <channel> <message-ts>` | Read-only link lookup for an already known exact timestamp | User |
| `trigger <turn-id>` | Exact active turn's `{channel, message_ts, thread_ts}` from the local state database | No Slack credential |

Channels accept managed names (with or without `#`) or Slack conversation IDs. `resume`, `upload`, and `resolve-upload --thread` take a **root** timestamp, preserved as a string. `audit` accepts either a root or a reply: pass the triggering message's timestamp directly. Threaded posting verbs reject a missing/malformed timestamp; `post` rejects `--thread` rather than silently creating a new root. Files can be supplied without text. Existing `post <channel> "text"` and `--file=<path>` syntax still work. Use `--` before text that begins with an option.

`thread-of` and audit preflight use `reactions.get(channel, timestamp)` to obtain the exact message, even when it has no reactions. They require the returned type, channel, and message timestamp to match; the returned `message.thread_ts` identifies the root, or its absence identifies the matched message itself as the root. A malformed parent, mismatched identity, inaccessible message, or `message_not_found` is an error, never a reason to use a nearby result. No `conversations.history` lookup is involved. `thread-of` returns the normal JSON receipt shape: `ts` and `permalink` identify the queried message, while `thread_ts` is always its confirmed root (itself for a top-level message). `audit` uses this same primitive internally and posts nothing unless it succeeds.

`react`, `todo-add`, `channel-id`, and `channels-list` retain their existing contracts. `help` lists the posting and recovery commands; `list-add` remains retired.

## Identity supplied with each input

Concierge prepends the following block to each real Slack input, including every mid-turn steering message:

```text
<slack-message-context>
{"channel_id":"C123ABC","message_ts":"1756000002.000003","thread_ts":"1756000000.000001"}
</slack-message-context>
```

Use that input's `channel_id` and `message_ts` with `audit` or `react`. `thread_ts` is the input's visible reply root (the same as `message_ts` for a root message), not the persistent provider session anchor. Channel and DM inputs use the same contract. Each steering input carries its own message identity; the helper does not choose a "latest" input. These fields remain strings and are validated before preparation proceeds. A missing/malformed channel or timestamp is an error, not a fallback to another message.

The block is part of both live dispatch and canonical replay text, including file-only and audio-only input. Synthetic comparison/deployment input has no fabricated Slack identity. No helper arguments acquire environment-derived defaults.

## Diagnostic lookup of the turn's original trigger

Take the explicit turn ID from the artifact directory already supplied for the current turn: `.artifacts/turn-<id>-<token>/`. Run `router-actions.sh trigger <id>` and use the returned `channel` and `message_ts` with `audit`:

```json
{"channel":"C123ABC","message_ts":"1756000002.000003","thread_ts":"1756000000.000001"}
```

`trigger` reads one exact `turns.id`, joins its session only for the channel, and returns `turns.slack_user_msg_ts` plus `turns.slack_reply_thread_ts`. The session anchor is never a reply-root fallback. Only a running `slack_user` turn with complete, valid string identity succeeds. Unknown IDs, stale/terminal turns, synthetic work, absent roots, malformed IDs, or unavailable databases are errors with empty stdout and structured JSON on stderr. This local lookup performs no Slack request, reads no Slack token, and has no posting `delivery` classification.

The turn ID is required. Ambient `CONCIERGE_TURN_ID` can outlive a turn in a reused tool host, so it is not accepted as an implicit default. The helper neither scans artifact directories nor chooses the newest database row, channel message, or steering input. The result identifies the original message that created the specified turn; later steering does not rewrite that trigger. Use the per-input block for steering identity, not this turn-level diagnostic.

## Success and failure

All posting verbs emit exactly one JSON object on stdout, only after both identity and permalink are known:

```json
{"channel":"C123ABC","ts":"1756000002.000003","permalink":"https://example.slack.com/archives/C123ABC/p1756000002000003?thread_ts=1756000000.000001&cid=C123ABC","thread_ts":"1756000000.000001","file_ids":["F123"]}
```

`thread_ts` is null for a new root post (or a standalone `permalink` lookup, which does not infer thread context); `file_ids` is empty for text and `thread-of`. Use the returned `permalink` in the audit text. Do not construct a URL or infer a timestamp. `audit` converts normal Markdown links and bold text through the same converter as routed input.

Text posts take their timestamp from `chat.postMessage`. Uploads reserve each file with a form-encoded `files.getUploadURLExternal` request, POST bytes to its upload URL without forwarding a Slack token, and complete all files once with the requested channel, optional thread, and converted initial comment. The reservation encoding is covered explicitly because Slack's live endpoint requires `filename` and `length` from form fields even though other helper writes use JSON. The helper then reads each exact file ID with `files.info`, selects only its share in the requested channel/thread, and requires one common timestamp across all files. Neither `conversations.history` nor `conversations.replies` is used. Finally `chat.getPermalink` supplies the message URL, not the file-download URL.

Failures produce JSON on stderr and a nonzero exit (2 for invalid arguments, 1 for runtime failures); stdout contains no partial success. Every error has `code` and `error`. Runtime errors after setup carry `channel`, `thread_ts`, `file_ids`, and a `delivery` classification. Audit/thread lookup errors retain the requested `message_ts`; `thread_ts` remains null until verified:

- `not_sent`: no message/share write was attempted; upload reservations may exist but were not completed.
- `unknown`: a write may have been accepted, or a read-only upload lookup has not proven a share. Do not repeat the post.
- `confirmed`: Slack accepted the post/share, even if identity metadata or the permalink read failed. Do not repeat the post.

Expected propagation is not a caller-visible failure on its first occurrence. After a confirmed write, the helper resolves its entire receipt within **one 30-second read budget**, shared by all file IDs and the permalink. A file with the requested ID but no visible shares is pending. Transient read transport failures, HTTP 429/5xx, and Slack `ratelimited`, `internal_error`, `service_unavailable`, or `request_timeout` errors also retry. Delays start at 1 second, double to 8 seconds, and honor a longer `Retry-After`. Both response headers and body reads use the remaining deadline as an abort timeout. Writes, including byte transfer and upload completion, are never inside this retry loop.

`resolve-upload`, `permalink`, and `thread-of` use the same bounded read behavior. Audit preflight has its own 30-second read budget before any write; its post-write receipt starts a fresh 30-second budget. Thus an audit can spend at most 60 seconds waiting on reads, plus the single write itself. The 30 seconds is an interactive patience policy, not a Slack propagation SLA or an end-to-end timeout for byte uploads/writes.

| Error code | Meaning | Caller action |
| --- | --- | --- |
| `receipt_timeout` | Known-safe reads could not finish within the budget | Report unresolved receipt; do not repost or start an unbounded recovery loop |
| `identity_mismatch` | Wrong file/message/channel/thread, invalid parent, or files identifying different messages | Inspect the target/identity; do not retry as propagation |
| `ambiguous_share` | Multiple distinct shares in the requested channel/thread | Caller must resolve ambiguity; no automatic choice |
| `action_failed` | Other failures, including permanent Slack errors, invalid responses, or an uncertain write | Read `error` and `delivery`; repair/inspect rather than blindly retrying |

Wrong-channel/thread share metadata is not treated as merely absent metadata. Share containers and every share's timestamp fields are validated before selecting an identity; a valid entry beside a malformed entry is an error, not proof of uniqueness. Auth/scope errors and `file_not_found`/`message_not_found` stop immediately. If Slack's `Retry-After` cannot fit within the remaining budget, the command exits early with `receipt_timeout` and `retry_after_ms` rather than retrying too soon. A timeout does not turn a confirmed write into an ambiguous one: `delivery: confirmed` is preserved. An uncertain original write remains `unknown` and is never automatically replayed.

When exceptional recovery is possible, `recover` contains exact **read-only** arguments, for example `['resolve-upload', 'C123ABC', '--thread', '1756000000.000001', '--file-id', 'F123']`. A failed receipt read after a confirmed text post includes its exact `ts` and `['permalink', channel, ts]`. These are for later deliberate recovery after a surfaced timeout/error, not routine caller-managed polling. Respect any returned `retry_after_ms`. A transport failure before a text timestamp is returned has no exact automatic recovery command; inspect that uncertain outcome instead of reposting.

There are no automatic write retries, history scans, background workers, new credentials, or persistent state. A successful no-lag upload performs one read per file plus one permalink read; backoff adds at most five retry attempts across a 30-second read budget. Verified files are not reread. Cost grows with files in this invocation, not retained history or workspace size; idle cost is zero. Work stops on success, permanent/mismatched/ambiguous evidence, or budget exhaustion. Events would require a long-lived subscription and handoff for this short-lived CLI; bounded exact-ID reads keep ownership local.

## Caller migration

The old `post` stdout was a bare timestamp or comma-separated file IDs. It is now always JSON on success. Change consumers to parse `ts` and `permalink`, and remove any recency lookup, URL construction, or raw posting/upload calls. Direct `bun scripts/router-post.ts <channel> ...` invocations remain supported with the same new JSON output.

The separate `slack-inbox` project's instruction owner should replace its former "no internal retry; rerun recover until it resolves" guidance with this contract (that repository is not edited here):

> Use `channel_id` and `message_ts` from the `<slack-message-context>` block attached to the input you are handling. Pass them to `audit`, which confirms the root itself, or `react`, which targets that exact message. Each steering input has its own block. `trigger <turn-id>` remains available to inspect the original turn trigger; it does not identify a steering message. Do not use ambient turn IDs, the provider session anchor, or channel recency. Missing identity or a failed lookup is an error, never permission to guess. Call each posting verb once and use its returned `ts` and `permalink`. The helper handles expected propagation and transient read failures within a bounded budget. On an error, do not loop or repost: distinguish `receipt_timeout` from identity/ambiguity/permanent failures, preserve `delivery`, and report the unresolved outcome. `recover` is exceptional read-only recovery, not an instruction to poll. Use `thread-of` only when a separate confirmed root lookup is needed, and read its `thread_ts`.

Configuration continues to come from `/root/.config/concierge/slack.toml` (`user_token` / `bot_token`) and the Concierge channel registry. `CONCIERGE_SLACK_CONFIG` and `CONCIERGE_STATE_DB` support isolated runs, matching `router-todo.ts`; `CONCIERGE_ROUTER_BOT_DIR` selects a worktree's backing scripts for tests. No Slack scope changes are required: the manifest already grants user `chat:write`, `files:write`, `files:read`, and both tokens' `reactions:read`.

## Verification and provider references

Run `cd bot && bun test tests/router-post.test.ts tests/router-todo.test.ts tests/deploy.test.ts`. Fixtures exercise exact root/reply lookup, wrong-thread audit prevention, bounded propagation/read retries, Retry-After, stalled response aborts, permanent/ambiguous failures without retries, shared multi-file deadlines, token selection, and Markdown conversion. Every receipt verb advertised by `--help` has a real shell/CLI execution case; `thread-of` covers reply, root, and structured not-found results. Deployment fixtures execute the existing runner with external side effects stubbed, proving the installed wrapper advances from prior LKG to the promoted artifact before success, and that failed promotion or missing helper cannot report success. They do not post into live Slack. Read-only preflight confirmed that `reactions.get` returns existing root/reply identity with zero reactions and rejects a nonexistent timestamp under both configured tokens.

Provider contracts: [external upload reservation and byte POST](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/), [single upload completion and root thread targeting](https://docs.slack.dev/reference/methods/files.completeUploadExternal/), [file share identity metadata](https://docs.slack.dev/reference/methods/files.info/), [exact message lookup](https://docs.slack.dev/reference/methods/reactions.get/), [message permalink lookup](https://docs.slack.dev/reference/methods/chat.getPermalink/), and [Retry-After](https://docs.slack.dev/apis/web-api/rate-limits/#responding-to-rate-limiting-conditions).
