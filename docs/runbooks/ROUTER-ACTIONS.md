# Router action helper

## Waiting for a local process

Use `router-actions.sh wait --pid <pid> [--pid <pid> ...] [--timeout 30m]` when
an agent must wait for a shell it started. It checks exact process IDs and returns
when all have exited. A timeout exits 124 and names any still-running IDs. The
pre-command guard refuses a loop around a full-command process-name search,
because such a loop can match itself and hold a run open indefinitely.

## Current native routing

Project setup uses the same local owner socket on either machine:

```bash
router-actions.sh projects new command-line-tools --purpose "Shared commands for Tejas's machines."
router-actions.sh projects new local-experiment --purpose "A local experiment workspace." --here-only
router-actions.sh projects share life-logistics --to mac
router-actions.sh projects status life-logistics --to mac
router-actions.sh projects cancel life-logistics --to mac  # only while still recorded
```

An agent appends its exact `--source-input` and `--source-run` pair to `new` or `share`;
a terminal user omits it. A new project gets the canonical instruction file, its Claude
symlink, docs index, Git ignore and a notes link when this machine has a vault root. It is
committed and pushed to a private `tejasdc` GitHub repository before the peer order is
recorded. A repeated `new` completes an interrupted creation. `share` requires the same
named origin and a branch already pushed there. The other machine may be asleep; status
shows the retained order and its result when it arrives.
Cancellation is accepted only before any delivery attempt; it never undoes a peer checkout.

New work goes to Thinkering native sessions, including requests arriving through
the retained DM. Agent Slack post/resume/upload/request ingress and automatic
legacy routed recovery are retired; those commands refuse before publication.

Continue one exact owning session when it built the surface that the capture
concerns and remains messageable. Use `sessions search` and `sessions context`
to establish title, project, source and dialogue before copying its address:

```bash
router-actions.sh sessions projects --source-input '<inputId>' --source-run '<runId>'
router-actions.sh sessions search --source-input '<inputId>' --source-run '<runId>' -- 'distinctive concept'
router-actions.sh sessions context '<exact-discovered-address>' --source-input '<inputId>' --source-run '<runId>'
router-actions.sh sessions ask '<exact-discovered-address>' \
  --source-input '<inputId>' --source-run '<runId>' --action-id '<stable-action>' \
  --requested-effect work --capture-id '<retained-captureId>' --text-file '<brief-path>'
```

Mere topical similarity and consultation-only evidence do not establish an
owner. Clarify ambiguous ownership instead of choosing a near-match. If no
session owns the work or the surface is genuinely different, create a fresh
Claude Opus session:

```bash
router-actions.sh sessions ask --provider cc-opus \
  --project thinkering --session-name 'Startup responsiveness' \
  --source-input '<inputId>' --source-run '<runId>' --action-id '<stable-action>' \
  --requested-effect work --capture-id '<retained-captureId>' --text-file '<brief-path>'
```

The retained Slack source pair may replace the native pair. Never mix them.
`cc-opus` is the configured default for a new session; a registered project that
has its own selected default keeps that selection. Use another model alias,
including `cx-sol` or `cx-astra`, for an explicit human choice; no escalation or
fallback is silent.
`sessions projects` lists current canonical project folders under the workspace root:
each has a real `AGENTS.md` and Git root. It no longer depends on the retained
Slack `channels` table. `--project` resolves one exact listed name or cwd at the
owner; it does not accept an arbitrary cwd. `D0BMWUJ3RD5` is a retired DM folder,
not a routing target. Concierge implementation belongs to `slack-concierge`;
Thinkering implementation belongs to `thinkering`. If a project is missing or
unclear, ask instead of selecting an unrelated folder. The native Inbox router
itself uses Claude Opus with 1M context in `slack-inbox`, while newly created
destination sessions use Sol at medium effort. Alias resolution pins the exact
model and effort in native session metadata and queued execution. `--session-name`
sets the canonical title. No Slack root is created and no human origin is forged.
An explicit human session/provider/model/effort choice takes precedence.
Existing addressed sessions preserve their provider/project; provider selection
creates a new session. Do not alter or replay already-running work because of
this routing default. ChatGPT uses `--provider chatgpt` without project or effort.

The former always-fresh rule controlled GPT-6 Astra credits; it is retired now
that destinations run GPT-5.6. In the September 16 sidebar incident, three
fresh sessions each added an indicator for adjacent Thinkering state within
an hour, leaving no session responsible for how they composed. Keep one owner
per surface when exact session evidence supports it.

Repeated `--file <path>` reads authorized exact local bytes into the one source-bound
request; the owner stores them transactionally in its attachment custody. Local paths
are not retained identities. `--capture-id` forwards original retained Inbox files.
`--text-file` preserves a long brief without command-argument limits. Capture recovery
must use original custody, not a cleaned temporary path or a made-up transcription.
The receipt adds `target_address` and canonical `target` to existing request/input/
operation IDs. Inspect or retry the same identity after uncertain transport; do not
create a replacement action. The original human task remains the authority.

`sessions note <captureId> <source flags> --action-id A` saves a real editable
Thinkering note from immutable source bytes. See [native Inbox](../contracts/native-inbox.md)
for capture/import and private producer contracts. The existing project testing policy applies unless a human
request explicitly supplies a scoped exception.

`systemd/router-actions.sh` is installed by Concierge's normal deployment at
`/root/.local/bin/router-actions.sh`. Its session commands use the common owner.
The service's PATH omits `~/.local/bin`, so provider sessions inherit no bare
`router-actions.sh`; the session instructions name the helper by its absolute path.
Do not fix this by prepending `~/.local/bin` to provider PATH: it holds a `codex`
shim that would shadow the provider executable. Before the absolute path, every
manually started session's `sessions title` call failed and the session stayed unnamed.
The backing router-post CLI rejects old `post`, `resume` and `upload` invocations,
including direct script calls; the private `POST /requests` and recovery routes
return `410 slack_routing_retired`. Audit and read-only receipt operations retain
their independent Slack surface adapter. Capture custody is unchanged.

The deployment runner initially installs the wrapper from trusted control/LKG. After health proof and promotion, it refreshes the wrapper from the promoted artifact before recording success. Omitting that refresh leaves the previous release's dispatch table installed even though `--help` reads the newer backing script. Wrapper changes therefore require both shell execution coverage and promotion-install coverage; checking the backing function alone cannot establish entrypoint reachability.

## Legacy delivery evidence

No new agent request publishes through a Slack user credential. Historical Slack
source flags and verified v1 destination addresses are accepted only as provenance;
the coordinator retains native input/run identity and canonicalizes the target
address before dispatch. Replies use the native return owner too.

Existing admitted or settled routed records remain unchanged. Unresolved legacy
publication/request/return records are exposed as `uncertain` with an owner
reconciliation explanation. They are not automatically failed, republished or
re-admitted; deadlines do not create new provider wakes for these records.
Exact late Slack echoes remain evidence, never fresh human inputs. Inspect the
same request ID via `sessions get` or read-only `work request`. Do not create a
replacement action or invoke `work recover` to bypass uncertain effects.

## Agent session communication

Another Concierge instance is a peer: `sessions peers` lists them, and `--peer <instance>`
on `projects`, `search` and `ask` targets that instance's projects and sessions. A peer
request keeps its return obligation here; the recipient on the peer replies with the
ordinary `sessions reply`. See [peer instances](PEER-INSTANCES.md).

To answer a thread of your own Inbox, post into it deliberately:

```bash
router-actions.sh sessions post \
  --source-input '<inputId>' --source-run '<runId>' --action-id '<stable-action>' \
  --thread '<message-id>' --text-file '<reply-path>'
```

`--thread` is the exact message ID the thread is rooted at or continues. That is the same
identity a human reply carries in `replyToMessage.messageId`, so both sides address a
thread the same way. The post is the thread's reply; your other working output is not.
Only the Inbox accepts posts. A post starts no turn and owes no reply. The native Inbox
contract describes how it is recorded and threaded.

`post` and `reply` both carry files: repeated `--file <path>` sends your own bytes, and
repeated `--attachment <custody-id>` places a file already in custody — a worker's returned
images — without downloading and re-uploading it. The owner retains every file before it
acknowledges the action, so a retry of the same action ID reuses that custody and different
bytes conflict rather than sending a second copy. A reply or post carrying at least one file
may omit its text; with neither text nor a file it is refused. This is how a result with
mockups reaches the thread it belongs to instead of arriving as a new request.

Use `sessions` to discover and communicate with exact Concierge-owned sessions.
The service chooses how to deliver into the destination's current lifecycle;
callers do not choose steering, resumption, a provider ID, or a Slack root.
Native and Slack-born sessions share the same owner and discovery catalogue.
Historical sources retain their consultation-only label and availability;
discovery does not make them executable. Existing read-only `threads` queries,
bot audit and reaction surface commands retain their independent contracts.

Every command, including searches and reads, requires exactly one source pair.
For a native input, copy `input.id` and `input.runId` from the owner-generated
`concierge-session-input` JSON envelope into `--source-input` and `--source-run`. Its
`input.origin` describes the authenticated author independently of the transport;
the separate `content` string cannot replace that identity. These IDs identify
the accepted input and its admitted live run, not a session ID, provider thread,
or the newest run. The owner validates their relationship and current admission.
For Slack input, continue using `--source-channel` and `--source-ts` from that
input's `<slack-message-context>`. Never mix the pairs or borrow another input's
identity. Missing pairs fail locally; no environment variable supplies defaults.

Native commands need no Slack identity:

```bash
router-actions.sh sessions search --source-input '<inputId>' \
  --source-run '<runId>' --limit 5 -- "concept one" "concept two"
router-actions.sh sessions context '<discovered-address>' \
  --source-input '<inputId>' --source-run '<runId>'
router-actions.sh sessions ask '<discovered-address>' \
  --source-input '<inputId>' --source-run '<runId>' \
  --action-id question-one -- 'Question text'
router-actions.sh sessions reply '<exact-request-id>' \
  --source-input '<answer-inputId>' --source-run '<answer-runId>' \
  --action-id answer-one -- 'Answer text'
router-actions.sh sessions get '<exact-request-id>' \
  --source-input '<inputId>' --source-run '<runId>'
```

The existing Slack form is unchanged:

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
candidate context before addressing a question. Both source forms return the common
`{results:[{session,evidence}],coverage}` shape. Copy `results[i].session.address` exactly;
`results[i].session.id` (such as `concierge:2673`) is not an address. Retained native input
and provider-message matches precede catalogue-only and legacy routing matches. Use
`session.capabilities` and `session.interactionPolicy` to distinguish direct communication
from historical consultation; search success alone does not authorize execution.

`ask` requires an explicit stable `--action-id`. Distinct questions from the same
input use distinct action IDs and retain their separate returned request IDs.
Optional repeated `--after-request` flags name exact request dependencies; they
do not grow to include later work. A dependency that settles without confirmed
success (unanswered, decision needed, or a work answer with no disposition) holds
requests asked before that outcome reached the requester; an ask made after
seeing it is the requester's decision and is delivered. `sessions cancel
<request-id> --action-id A` withdraws the caller's own request, such as one it has
superseded; a request not yet handed to its recipient is never delivered afterwards. `reply` targets one exact returned request ID,
with its own stable source-scoped action ID. Replies are final by default;
`--partial` explicitly keeps the answer partial. Repeated replies use distinct
actions when their content or finality changes. Quote question/answer text as
one argument after `--`; the helper preserves its exact bytes. Missing values,
repeated scalar flags, repeated dependency IDs, and extra positionals fail
before contacting the service.

For explicit human intent such as “ask ChatGPT for this information,” the admitted
agent uses the same ask command with `--provider chatgpt` instead of an address:

```bash
router-actions.sh sessions ask --provider chatgpt \
  --source-input '<inputId>' --source-run '<runId>' \
  --action-id '<stable-action>' -- '<authorized question>'
```

The exact Slack source pair works too. The owner atomically creates one native
ChatGPT session and agent-origin first input with the existing request/return
obligation. The receipt retains `request_id`, `operation_id`, `target_session_id`
and `target_input_id`. Use an existing discovered address when the user selected
an existing conversation. An unavailable capability returns a durable failure;
an uncertain start retains its evidence. Neither substitutes another provider
nor creates a replacement session on retry. ChatGPT returns through the service;
it receives no outbound session tool. Ordinary-language interpretation remains
in the existing application instructions, with no second intent recognizer.

The helper performs one `POST /session-communication/<command>` through
`requests.sock` beside `CONCIERGE_STATE_DB`, using the existing socket resolver.
It reads no Slack credential and publishes no Slack message independently.
Search, context, and get are read-only service operations despite using POST.
Question delivery and correlated returns belong to the service coordinator.
The owner independently rejects model messaging from consultation-only sessions;
possession of a source pair never upgrades their policy. A native question or
return never publishes a Slack message.

Successful HTTP responses print the exact JSON receipt on stdout. Non-success
HTTP responses print the exact JSON error receipt on stderr and exit 1;
argument errors exit 2. Preserve every returned field and request identity.
A successful process exit or `recorded` status proves neither admission nor
delivery. The helper does not translate `recorded`, `admitted`, or `parked` into
another status, and it never waits for admission or retries automatically.
Transport or unreadable-response errors retain the source/action and target
identity without asserting whether the service accepted the operation.

An `ask` that delegates implementation must pass `--requested-effect work`.
Omitting it records an informational request, and nothing warns you: the
recipient may then only investigate and answer, and a request body that says
"implement and deploy" does not override the flag. The recipient is right to
follow the flag, so a missing one costs a full round trip. This bites hardest
when creating a new session with `--provider`, whose usage line does not show
the flag. Observed September 18, 2026: a display fix sent to a freshly created
Thinkering session came back designed but deliberately unbuilt.

Every `ask` creates a return obligation that only its recipient can discharge
with `reply`. Writing "no reply needed" in the body does not settle it; the
helper exposes no cancel verb, so an unsettled request waits for its deadline
and wakes an overdue inspection. Send information a recipient must act on as an
`ask` and accept that it owes a reply, and do not open one purely to inform.

Several asks to one busy session usually land in one turn: the first opens it and
the rest steer in. Reply to each of them, and when one answer covers several, say
so in a single final reply — the owner settles the others from it rather than
recording finished work as unanswered. Every request header's own source pair works,
including one the provider never formally acknowledged, and a run that follows an
interruption can still answer requests delivered to the earlier run.

That obligation has a cost beyond the recipient. A reply and an overdue
inspection each return to the sender and start a turn there, so two agents
informing each other keep generating turns after the work is done. Release
promotion waits for an idle boundary, polling rather than interrupting, so a
running turn holds the rollout: an exchange about a change can be what stops
that change from shipping. This was observed on September 17, 2026 — a promotion
sat in its poll loop while the session that had pushed the commits was the only
running turn in the ledger. Ending the turn is the action that ships the work,
which is why delivery ends at the push.

Inspect the exact request with `get` on demand, including one overdue inspection
when needed. Do not build a polling loop or create a new action to bypass an
unresolved outcome. If an action must be submitted again, retain the original
source, action ID, and payload. `sessions --help` prints the command syntax
without opening the service socket. The existing deployment installs the
updated wrapper; the backing client ships with the normal application artifact.

Targeted native communication coverage lives in
`bot/tests/native-communication.test.ts` and
`bot/tests/native-routing-retirement.test.ts`. Those tests exercise native owner
admission, exact partial/final correlation, Stop/archive, uncertain legacy effects,
and direct/wrapper/socket refusals. Follow the current project testing policy.

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

## Historical Slack adapter receipt reference

The following receipt format remains useful for reading old routed records and
for the independent bot-audit/capture adapter. It does not authorize agent posting
or recovery publication; all such ingress now refuses.

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

## Owner binding

Agent callers use `sessions` with the exact accepted source identity. Legacy
`post/resume/upload` and `work recover` calls refuse, including direct script
invocations. Read-only `work request` keeps the original receipt and uncertainty.
The API socket comes from the directory containing `CONCIERGE_STATE_DB`, then
`CONCIERGE_STATE_DIR` when no database override is supplied. Standalone installed
callers retain the production default.

Managed provider runs receive those paths from `provider-owner-environment.ts`: the required service state directory determines the socket, and source-run helpers use that exact worktree. The model's cwd and stale turn environment cannot select another owner. Immutable production bundles preserve the installed checkout's helper backing. Claude initial/resumed processes retain the binding during steering; Codex initial/resumed threads and reconnects receive it through their shell environment policy. A missing owner state or unbound helper directory fails before provider execution. A missing socket fails without another destination or action retry. Headless runs bind the legacy Slack config path to `/dev/null`, while information-only consultations retain their existing no-tools policy. Exact input/run or Slack source flags still come from the current input; the CLI never infers them from ambient environment variables.

## Historical adapter references

Provider contracts: [single-message length guidance and truncation warnings](https://docs.slack.dev/reference/methods/chat.postMessage/#truncating), [external upload reservation and byte POST](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/), [single upload completion and root thread targeting](https://docs.slack.dev/reference/methods/files.completeUploadExternal/), [file share identity metadata](https://docs.slack.dev/reference/methods/files.info/), [exact message lookup](https://docs.slack.dev/reference/methods/reactions.get/), [message permalink lookup](https://docs.slack.dev/reference/methods/chat.getPermalink/), and [Retry-After](https://docs.slack.dev/apis/web-api/rate-limits/#responding-to-rate-limiting-conditions).
