# Router action helper

`systemd/router-actions.sh` is installed by Concierge's normal deployment at `/root/.local/bin/router-actions.sh`. Routed `post`, `resume`, and `upload` commands submit one request to the service API; the service uses the existing `router-post.ts` transport and `toMrkdwn` converter. The router never publishes independently. Agent session communication uses the same private service socket through `sessions`. Audit and read-only receipt operations retain their direct helper transport. There is no caller token option.

The deployment runner initially installs the wrapper from trusted control/LKG. After health proof and promotion, it refreshes the wrapper from the promoted artifact before recording success. Omitting that refresh leaves the previous release's dispatch table installed even though `--help` reads the newer backing script. Wrapper changes therefore require both shell execution coverage and promotion-install coverage; checking the backing function alone cannot establish entrypoint reachability.

## Commands

### Explicit provider selection

`post`, `resume`, and `upload` accept `--provider <cc|cc-fast|cc-medium|cc-fable|cx|cx-fast|cx-medium>`. Provider names `claude-code` and `codex` normalize to `cc` and `cx`. Models resolve through the alias table; invalid or repeated selections fail. The private API field is `provider: "cc"`, alongside the existing source, action, destination, task, defer, and dependency fields.

The router honors explicit user choice first. Otherwise it selects `--provider cc` for design, brainstorming, and review, even when the channel defaults to Codex. For other work, omit the flag to retain existing bound-session/channel routing. The service treats the field as authoritative over aliases in forwarded text and never classifies prose. [Provider sessions](../architecture/PROVIDER-SESSIONS.md) owns the unified precedence and quota policy.

```bash
router-actions.sh resume <resolved-channel> <resolved-root> \
  --source-channel <this-input-channel> --source-ts <this-input-ts> \
  --action-id design --provider cc -- '<design request>'
```

The routed message shows the chosen provider/model, including when its full task is attached. The result adds `provider_selection: {alias, provider, model, continuation_from}`. `status=admitted` still proves publication/admission, not provider completion or available quota. A different-provider resume returns a NEW linked root, carrying recorded user requests and agent answers after the source's accepted turns settle. Link to the returned destination; do not describe it as a native session transfer. Same-provider selection keeps the session and queues a separate turn with the selected model. New selected sessions remain isolated from shared channel sessions.

The user can correct selection by asking the router to use a specific provider; send the corrected next request through this same flag. Claude tries the existing exact-model usage fallback chain, then visibly reports exhaustion and Retry. Never silently select Codex. Missing canonical context or unreplayable attachments require an explicit continuation brief and needed files; explain any rejection or parked result instead of claiming a session started. For unresolved request status retain its request ID and use `work request`, as usual.

Every `post`, `resume`, and `upload` below requires `--source-channel <this input's channel_id> --source-ts <this input's message_ts>`, before `--`. Use distinct stable `--action-id` values when splitting one source into multiple requests; the default is `primary`. These exact identities come from the supplied Slack context, including for steering inputs.

Explicit waits additionally take repeated `--after <turn_id>,<channel_id>,<root_ts>` using exact references from `work <channel> --before-ts <source-message-ts> [--root-ts <root> | --session-id <id> | --turn-id <id>]`. The read-only lookup returns execution state and input evidence, exact channel/root/session identity, and `complete`. Require complete, unambiguous evidence for every named dependency. A complete empty selection uses `--defer`; ordinary requests omit wait flags. `--turn-id` can resolve a completed execution. New work in those sessions never expands the frozen set.

The machine result includes `request_id`, `status`, `turn_id`, and the exact Slack receipt when known. Only `status: admitted` confirms publication and durable input admission; the turn may still be waiting. Other statuses preserve the accepted operation and its uncertainty. Inspect on demand with `work request <request_id>`; never create a different action to bypass an unresolved publication. The destination shows only ⏳ while waiting. Do not post waiting receipts or activation announcements. See [routed request ownership and recovery](../architecture/ROUTED-REQUESTS.md).

`work recover <request_id>` asks the service to reconcile that same durable operation using its recorded receipt, reserved upload IDs, or exact client-message identity. It does not require the caller's original attachment paths and never blindly republishes an ambiguous write. Use it on demand when the service reports missing receipt evidence; do not run a polling loop.

| Command | Effect | Credential |
| --- | --- | --- |
| `post <channel> [--file <path> ...] -- <text>` | New top-level input; optional files | User |
| `resume <channel> <thread-ts> [--file <path> ...] -- <text>` | Input in an existing thread; optional files | User |
| `upload <channel> <thread-ts> --file <path> [--file <path> ...] [-- <text>]` | File input in an existing thread; requires a file | User |
| `audit <channel> <trigger-message-ts> -- <text>` | Confirm the triggering message's root, then post the audit/clarification there | Bot |
| `react <channel> <message-ts> <emoji>` | Add the outcome reaction to the exact message and remove the router's in-progress reaction | Bot |
| `thread-of <channel> <message-ts>` | Confirm exact message identity and return its root in `thread_ts`, with the queried message's `ts` and permalink | User |
| `resolve-upload <channel> [--thread <thread-ts>] --file-id <id> [--file-id <id> ...]` | Read-only file-share receipt recovery | User |
| `permalink <channel> <message-ts>` | Read-only link lookup for an already known exact timestamp | User |
| `trigger <turn-id>` | Exact active turn's `{channel, message_ts, thread_ts}` from the local state database | No Slack credential |
| `threads search [<channel>] --before-ts <message-ts> [--exclude-channel <channel> --exclude-root-ts <root>] [--limit <1..10>] -- <concept...>` | Bounded historical destination candidates globally or in one optional channel filter | No Slack credential |
| `threads context <channel> <root-ts> --before-ts <message-ts> [--limit <1..20>]` | Bounded approved evidence for one exact candidate | No Slack credential |
| `threads stats` | On-demand index size/count/time diagnostics | No Slack credential |

Channels accept managed names (with or without `#`) or Slack conversation IDs. `resume`, `upload`, and `resolve-upload --thread` take a **root** timestamp, preserved as a string. `audit` accepts either a root or a reply: pass the triggering message's timestamp directly. Threaded posting verbs reject a missing/malformed timestamp; `post` rejects `--thread` rather than silently creating a new root. Files can be supplied without text. Existing `post <channel> "text"` and `--file=<path>` syntax still work. Use `--` before text that begins with an option.

Slack can turn `chat.postMessage` text above 4,000 Unicode characters into
multiple independent messages while returning only the last message's timestamp;
in a routed channel that turns one intended request into multiple agent inputs.
The helper therefore sends converted text up to 4,000 characters directly and
automatically changes longer text into one file-backed Slack message. Its short
visible comment identifies `routed-request.txt`, while that generated attachment
contains the exact original body and shares the same single receipt as any
caller-supplied files. Concierge downloads the attachment and instructs the
destination agent to inspect it before routing or answering. No caller decision
or manual retry is required. If Slack nevertheless returns a
`message_truncated` warning for an accepted post or upload comment, the helper
surfaces `message_truncated` with `delivery: confirmed` and never returns a
success receipt.

`thread-of` and audit preflight use `reactions.get(channel, timestamp)` to obtain the exact message, even when it has no reactions. They require the returned type, channel, and message timestamp to match; the returned `message.thread_ts` identifies the root, or its absence identifies the matched message itself as the root. A malformed parent, mismatched identity, inaccessible message, or `message_not_found` is an error, never a reason to use a nearby result. No `conversations.history` lookup is involved. `thread-of` returns the normal JSON receipt shape: `ts` and `permalink` identify the queried message, while `thread_ts` is always its confirmed root (itself for a top-level message). `audit` uses this same primitive internally and posts nothing unless it succeeds.

`todo-add` and `channel-id` retain their existing contracts. `channels-list`
lists active routing destinations and omits registry rows whose mode is `silent`,
so an archived project can remain registered for history without being offered to
the router. `help` lists the posting and recovery commands; `list-add` remains
retired.

## Identity supplied with each input

For resume discovery, use the [historical thread search contract](#historical-thread-discovery).

Concierge prepends the following block to each real Slack input, including every mid-turn steering message:

```text
<slack-message-context>
{"channel_id":"C123ABC","message_ts":"1756000002.000003","thread_ts":"1756000000.000001"}
</slack-message-context>
```

Use that input's `channel_id` and `message_ts` with `audit` or `react`. `thread_ts` is the input's visible reply root (the same as `message_ts` for a root message), not the persistent provider session anchor. Channel and DM inputs use the same contract. Each steering input carries its own message identity; the helper does not choose a "latest" input. These fields remain strings and are validated before preparation proceeds. A missing/malformed channel or timestamp is an error, not a fallback to another message.

The block is part of both live dispatch and canonical replay text, including file-only and audio-only input. Synthetic comparison/deployment input has no fabricated Slack identity. No helper arguments acquire environment-derived defaults.

## Agent session communication

Use `sessions` to discover and communicate with exact Concierge-owned sessions.
The service chooses how to deliver into the destination's current lifecycle;
callers do not choose steering, resumption, a provider ID, or a Slack root.
Native Thinkering sessions and archive reconstruction have separate owners and
are outside this helper's scope. Existing `threads`, posting, audit, and reaction
commands retain their contracts.

Every command requires the triggering input's exact `--source-channel` and
`--source-ts`, including searches and reads. Obtain these strings from that
input's `<slack-message-context>` block. The helper never substitutes ambient
turn identity or another input's timestamp.

```bash
router-actions.sh sessions search --source-channel C123ABC \
  --source-ts 1756000002.000003 --limit 5 -- "concept one" "concept two"
router-actions.sh sessions context '<discovered-address>' \
  --source-channel C123ABC --source-ts 1756000002.000003
router-actions.sh sessions ask '<discovered-address>' \
  --source-channel C123ABC --source-ts 1756000002.000003 \
  --action-id question-one --after-request '<exact-request-id>' -- 'Question text'
router-actions.sh sessions reply '<exact-request-id>' \
  --source-channel C123ABC --source-ts 1756000003.000004 \
  --action-id answer-one -- 'Answer text'
router-actions.sh sessions get '<exact-request-id>' \
  --source-channel C123ABC --source-ts 1756000002.000003
```

Search accepts 1–8 concepts, each quoted as one shell argument; `--limit` is an
optional positive integer subject to the service's discovery bounds. Inspect
candidate context before addressing a question. Copy the opaque `address` from
discovery exactly. It is not a caller-created address or a native provider ID.

`ask` requires an explicit stable `--action-id`. Distinct questions from the same
input use distinct action IDs and retain their separate returned request IDs.
Optional repeated `--after-request` flags name exact request dependencies; they
do not grow to include later work. `reply` targets one exact returned request ID,
with its own stable source-scoped action ID. Replies are final by default;
`--partial` explicitly keeps the answer partial. Repeated replies use distinct
actions when their content or finality changes. Quote question/answer text as
one argument after `--`; the helper preserves its exact bytes. Missing values,
repeated scalar flags, repeated dependency IDs, and extra positionals fail
before contacting the service.

The helper performs one `POST /session-communication/<command>` through
`requests.sock` beside `CONCIERGE_STATE_DB`, using the existing socket resolver.
It reads no Slack credential and publishes no Slack message independently.
Search, context, and get are read-only service operations despite using POST.
Question delivery and correlated returns belong to the service coordinator.

Successful HTTP responses print the exact JSON receipt on stdout. Non-success
HTTP responses print the exact JSON error receipt on stderr and exit 1;
argument errors exit 2. Preserve every returned field and request identity.
A successful process exit or `recorded` status proves neither admission nor
delivery. The helper does not translate `recorded`, `admitted`, or `parked` into
another status, and it never waits for admission or retries automatically.
Transport or unreadable-response errors retain the source/action and target
identity without asserting whether the service accepted the operation.

Inspect the exact request with `get` on demand, including one overdue inspection
when needed. Do not build a polling loop or create a new action to bypass an
unresolved outcome. If an action must be submitted again, retain the original
source, action ID, and payload. `sessions --help` prints the command syntax
without opening the service socket. The existing deployment installs the
updated wrapper; the backing client ships with the normal application artifact.

The focused command is `cd bot && bun test tests/router-sessions.test.ts`.
These fixtures cross the real shell wrapper and Unix socket, verifying exact
payloads, JSON receipts, error correlation, and existing `work` behavior. They
prove client handling, not server persistence or Slack delivery; whole-change
acceptance exercises those boundaries through a claimed Slack sandbox lane.

## Historical thread discovery

For every project-bound route, search globally before choosing the destination.
Use that input's exact `message_ts`, even inside an older root:

```bash
router-actions.sh threads search --before-ts 1788420135.485139 \
  -- "hair loss" "shower filter"
```

The optional positional channel is a filter, not a prerequisite:

```bash
router-actions.sh threads search life-logistics \
  --before-ts 1788420135.485139 -- "hair loss" "shower filter"
```

When already inside a thread, global search excludes the supplied visible root
by its full identity:

```bash
router-actions.sh threads search --before-ts 1788420135.485139 \
  --exclude-channel C0BNN5K4JSJ --exclude-root-ts 1788420000.000001 \
  -- "hair loss" "shower filter"
```

For channel-filtered search, `--exclude-root-ts` alone implies that filtered
channel. `--exclude-channel` without a root, or a global excluded root without
its channel, is invalid.
Default limit is five, maximum ten. Supply 1–8 concepts, each at most 200
characters and 1–16 Unicode word tokens, quoting each as one shell argument.
Caller text is never raw FTS syntax. Names (optionally prefixed with `#`) must
resolve uniquely through the registry; IDs must also be registered.

Success is one JSON object on stdout with `concepts`, `scope` (`all_channels` or
`channel`), `target_channel` (null globally, `{id,name}` when filtered),
`before_ts`, `exclude_root` (an exact pair or null), legacy-compatible
`exclude_root_ts`, `complete:true`, `has_more`, `results`, and `query_ms`. Each
result contains:

| Field | Meaning |
| --- | --- |
| `channel_id`, `channel_name`, `root_ts` | Exact Slack destination; IDs/timestamps stay strings |
| `date`, `last_activity_at` | Root time and latest eligible source time, in UTC |
| `title`, `snippet` | Initial-input excerpt (160 characters) and best matched excerpt (600 characters) |
| `matched_concepts`, `matched_source`, `matched_message_ts` | Supporting concepts and exact source; kind is `turn_input`, `steering_input`, or `delivered_tldr` |
| `score_components` | `{bm25,user_input_evidence}`; evidence, never identity confidence |
| `resumable`, `provider`, `session_status` | Current channel-mode/session ownership; unavailable metadata is null |

Both root and source strictly predate the cutoff. `has_more` means additional
matches exceed the requested limit. `complete` means eligible projection
validation passed; it does not prove the candidate list resolves user intent.
Resume only one clearly matching, resumable root, passing exactly its returned
channel/root to `resume`. A top score is not identity proof. Several plausible
candidates may be inspected with `threads context` before deciding:

```bash
router-actions.sh threads context C0123PROJECT 1786558965.762069 \
  --before-ts 1788420135.485139
```

Context requires the exact `channel_id` and `root_ts` returned by search and the
same input cutoff. It returns `channel`, `root_ts`, root `date`,
`last_activity_at`, `title`, `before_ts`, `corpus:"routing_evidence"`,
`complete:true`, `fragment_count`, `returned_fragment_count`, `has_more`,
current `resumable`/`provider`/`session_status`, `query_ms`, and chronological
`fragments`. Each fragment has `source`, `message_ts`, `date`, `text`, and
`truncated`. Default is eight fragments, maximum twenty; the earliest fragment
and newest evidence are retained, each text is capped at 1,200 characters.

Context is not a full-thread read. It exposes only indexed `turn_input`, sent
`steering_input`, and `delivered_tldr`; it never returns full agent responses,
raw Slack/provider history, attachments, tool output, or replay wrappers. If
bounded context is still ambiguous, ask rather than escalating to ad-hoc reads.

For a resume signal, empty, failed, incomplete, ambiguous, or non-resumable
evidence requires clarification; **never create a new root because retrieval
failed**. Clearly new work may retain `post` after destination-resolution
search; the absence of a historical match does not turn new work into a resume.
Concierge supplies this guidance with each real router input.

Search and context perform no Slack request, read no Slack configuration/token,
and write no database state. Failure leaves stdout empty and writes
`{ok:false,complete:false,code,error}` to stderr. Exit 2 covers invalid arguments
and unknown/ambiguous channels; exit 1 covers `search_incomplete` or
`search_unavailable`. Clarify and surface the failure; do not retry-loop or
repair the index from the router.

`threads stats` returns `version`, `document_count`, `oldest_source_at`,
`newest_source_at`, `database_bytes`, and `fts_payload_bytes`. Database bytes
measure SQLite pages; FTS payload bytes exclude page/B-tree overhead. The
[architecture](../architecture/ROUTER-SEARCH.md) owns corpus, startup/backfill,
mutation ownership, and recovery details.

## Diagnostic lookup of the turn's original trigger

Take the explicit turn ID from the artifact directory already supplied for the current turn: `.artifacts/turn-<id>-<token>/`. Run `router-actions.sh trigger <id>` and use the returned `channel` and `message_ts` with `audit`:

```json
{"channel":"C123ABC","message_ts":"1756000002.000003","thread_ts":"1756000000.000001"}
```

`trigger` reads one exact `turns.id`, joins its session only for the channel, and returns `turns.slack_user_msg_ts` plus `turns.slack_reply_thread_ts`. The session anchor is never a reply-root fallback. Only a running `slack_user` turn with complete, valid string identity succeeds. Unknown IDs, stale/terminal turns, synthetic work, absent roots, malformed IDs, or unavailable databases are errors with empty stdout and structured JSON on stderr. This local lookup performs no Slack request, reads no Slack token, and has no posting `delivery` classification.

The turn ID is required. Ambient `CONCIERGE_TURN_ID` can outlive a turn in a reused tool host, so it is not accepted as an implicit default. The helper neither scans artifact directories nor chooses the newest database row, channel message, or steering input. The result identifies the original message that created the specified turn; later steering does not rewrite that trigger. Use the per-input block for steering identity, not this turn-level diagnostic.

## Success and failure

Admitted routed requests emit one JSON object with `request_id`, `status: "admitted"`, `turn_id`, and the following Slack receipt fields. Unresolved routed requests instead report their durable identity and status without inventing a Slack receipt. Direct audit and read-only receipt verbs return the base receipt alone:

```json
{"channel":"C123ABC","ts":"1756000002.000003","permalink":"https://example.slack.com/archives/C123ABC/p1756000002000003?thread_ts=1756000000.000001&cid=C123ABC","thread_ts":"1756000000.000001","file_ids":["F123"]}
```

`thread_ts` is null for a new root post (or a standalone `permalink` lookup, which does not infer thread context); `file_ids` is empty for inline text and `thread-of`, while a long text body returns the generated attachment ID. Use the returned `permalink` in the audit text. Do not construct a URL or infer a timestamp. `audit` converts message-visible Markdown links and bold text through the same converter as routed input; a generated long-body attachment preserves the original text exactly.

`react` emits one JSON receipt on stdout after both Slack mutations prove
success or an idempotent equivalent. The receipt binds the action to the exact
input and names both outcomes:

```json
{"ok":true,"channel":"C123ABC","message_ts":"1756000002.000003","reaction":"thumbsup","outcome_reaction":"added","in_progress_reaction":"already_absent"}
```

`already_reacted` and `no_reaction` are reported as `already_reacted` and
`already_absent`, respectively. An HTTP, transport, malformed-response, or Slack
API failure exits nonzero and prints structured JSON on stderr with the exact
channel, message timestamp, and reaction plus `reaction_projection_failed` or
`reaction_projection_unproven`; it never returns empty output that could be
mistaken for success. Invalid arguments also return structured usage JSON rather
than failing inside the shell wrapper.

Inline text posts take their timestamp from `chat.postMessage`. File-backed
posts—including automatically attached long bodies—reserve each file with a
form-encoded `files.getUploadURLExternal` request, POST bytes to its upload URL
without forwarding a Slack token, and complete all files once with the requested
channel, optional thread, and converted initial comment. The reservation
encoding is covered explicitly because Slack's live endpoint requires `filename`
and `length` from form fields even though other helper writes use JSON. The
helper then reads each exact file ID with `files.info`, selects only its share in
the requested channel/thread, and requires one common timestamp across all
files. Neither `conversations.history` nor `conversations.replies` is used.
Finally `chat.getPermalink` supplies the message URL, not the file-download URL.

Failures produce JSON on stderr and a nonzero exit (2 for invalid arguments, 1 for runtime failures); stdout contains no partial success. Every error has `code` and `error`. Runtime errors after setup carry `channel`, `thread_ts`, `file_ids`, and a `delivery` classification. Audit/thread lookup errors retain the requested `message_ts`; `thread_ts` remains null until verified:

- `not_sent`: no message/share write was attempted; upload reservations may exist but were not completed.
- `unknown`: a write may have been accepted, or a read-only upload lookup has not proven a share. Do not repeat the post.
- `confirmed`: Slack accepted the post/share, even if identity metadata or the permalink read failed. Do not repeat the post.

Expected propagation is not a caller-visible failure on its first occurrence. After a confirmed write, the helper resolves its entire receipt within **one 30-second read budget**, shared by all file IDs and the permalink. A file with the requested ID but no visible shares is pending. Transient read transport failures, HTTP 429/5xx, and Slack `ratelimited`, `internal_error`, `service_unavailable`, or `request_timeout` errors also retry. Delays start at 1 second, double to 8 seconds, and honor a longer `Retry-After`. Both response headers and body reads use the remaining deadline as an abort timeout. Writes, including byte transfer and upload completion, are never inside this retry loop.

`resolve-upload`, `permalink`, and `thread-of` use the same bounded read behavior. Audit preflight has its own 30-second read budget before any write; its post-write receipt starts a fresh 30-second budget. Thus an audit can spend at most 60 seconds waiting on reads, plus the single write itself. The 30 seconds is an interactive patience policy, not a Slack propagation SLA or an end-to-end timeout for byte uploads/writes.

| Error code | Meaning | Caller action |
| --- | --- | --- |
| `receipt_timeout` | Known-safe reads could not finish within the budget | Report unresolved receipt; do not repost or start an unbounded recovery loop |
| `message_truncated` | Slack accepted a write but warned that message text was truncated or split | Treat the write as confirmed and inspect it; do not repost |
| `identity_mismatch` | Wrong file/message/channel/thread, invalid parent, or files identifying different messages | Inspect the target/identity; do not retry as propagation |
| `ambiguous_share` | Multiple distinct shares in the requested channel/thread | Caller must resolve ambiguity; no automatic choice |
| `action_failed` | Other failures, including permanent Slack errors, invalid responses, or an uncertain write | Read `error` and `delivery`; repair/inspect rather than blindly retrying |

Wrong-channel/thread share metadata is not treated as merely absent metadata. Share containers and every share's timestamp fields are validated before selecting an identity; a valid entry beside a malformed entry is an error, not proof of uniqueness. Auth/scope errors and `file_not_found`/`message_not_found` stop immediately. If Slack's `Retry-After` cannot fit within the remaining budget, the command exits early with `receipt_timeout` and `retry_after_ms` rather than retrying too soon. A timeout does not turn a confirmed write into an ambiguous one: `delivery: confirmed` is preserved. An uncertain original write remains `unknown` and is never automatically replayed.

When exceptional recovery is possible, `recover` contains exact **read-only** arguments, for example `['resolve-upload', 'C123ABC', '--thread', '1756000000.000001', '--file-id', 'F123']`. A failed receipt read after a confirmed text post includes its exact `ts` and `['permalink', channel, ts]`. These are for later deliberate recovery after a surfaced timeout/error, not routine caller-managed polling. Respect any returned `retry_after_ms`. A transport failure before a text timestamp is returned has no exact automatic recovery command; inspect that uncertain outcome instead of reposting.

The transport never automatically retries an ambiguous write or scans message history. A successful no-lag upload performs one read per file plus one permalink read; backoff adds at most five retry attempts across a 30-second read budget. Verified files are not reread. Routed publication intent is now durable in the service, and its existing Slack subscription supplies exact echo evidence when available. Read-only CLI verbs retain bounded exact-ID reads. Waiting adds no polling or new credential; idle cost is zero.

## Caller migration

Posting callers must supply the exact source flags and inspect `status`, then use the returned `ts` and `permalink` only after `admitted`. Direct `bun scripts/router-post.ts <channel> ...` invocations use this same service API. Source/action identity replaces caller-managed reposting. The API socket comes from the directory containing `CONCIERGE_STATE_DB`, or the production state directory by default.

The separate `slack-inbox` project's instruction owner carries the matching source/action, lookup, submission, and quiet-wait contract:

> Use `channel_id` and `message_ts` from the `<slack-message-context>` block attached to the input you are handling. Pass them to `audit`, which confirms the root itself, or `react`, which targets that exact message. Each steering input has its own block. `trigger <turn-id>` remains available to inspect the original turn trigger; it does not identify a steering message. Do not use ambient turn IDs, the provider session anchor, or channel recency. Missing identity or a failed lookup is an error, never permission to guess. Call each posting verb once and use its returned `ts` and `permalink`. The helper handles expected propagation and transient read failures within a bounded budget. On an error, do not loop or repost: distinguish `receipt_timeout` from identity/ambiguity/permanent failures, preserve `delivery`, and report the unresolved outcome. `recover` is exceptional read-only recovery, not an instruction to poll. Use `thread-of` only when a separate confirmed root lookup is needed, and read its `thread_ts`.

The service uses its runtime's existing Slack configuration and channel registry. Routed clients do not read Slack tokens. Audit/read-only transport still reads `/root/.config/concierge/slack.toml`, with `CONCIERGE_SLACK_CONFIG` for isolated runs; `CONCIERGE_STATE_DB` selects the matching runtime state and socket, and `CONCIERGE_ROUTER_BOT_DIR` selects a worktree's backing scripts. No Slack scope changes are required.

## Verification and provider references

Run `cd bot && bun test tests/router-post.test.ts tests/router-react.test.ts tests/router-todo.test.ts tests/deploy.test.ts`. Fixtures exercise exact root/reply lookup, wrong-thread audit prevention, observable reaction success/idempotency/failure, automatic long-body upload with exact byte preservation across all posting verbs, bounded propagation/read retries, Retry-After, stalled response aborts, permanent/ambiguous failures without retries, shared multi-file deadlines, token selection, and Markdown conversion. Every receipt verb advertised by `--help` has a real shell/CLI execution case; `thread-of` covers reply, root, and structured not-found results. Deployment fixtures execute the existing runner with external side effects stubbed, proving the installed wrapper advances from prior LKG to the promoted artifact before success, and that failed promotion or missing helper cannot report success. They do not post into live Slack. Read-only preflight confirmed that `reactions.get` returns existing root/reply identity with zero reactions and rejects a nonexistent timestamp under both configured tokens. The focused real Slack sandbox acceptance posts a body above 4,000 characters through the helper, verifies one root and one text attachment with matching start/end content, and requires the one destination provider turn to report markers placed at both ends before the run drains to zero unsettled work.

Provider contracts: [single-message length guidance and truncation warnings](https://docs.slack.dev/reference/methods/chat.postMessage/#truncating), [external upload reservation and byte POST](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/), [single upload completion and root thread targeting](https://docs.slack.dev/reference/methods/files.completeUploadExternal/), [file share identity metadata](https://docs.slack.dev/reference/methods/files.info/), [exact message lookup](https://docs.slack.dev/reference/methods/reactions.get/), [message permalink lookup](https://docs.slack.dev/reference/methods/chat.getPermalink/), and [Retry-After](https://docs.slack.dev/apis/web-api/rate-limits/#responding-to-rate-limiting-conditions).
