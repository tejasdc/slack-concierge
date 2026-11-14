# Router action helper

## Per-session Pause and Continue

An admitted native agent run with work authority can control one exact native session
on its own Concierge instance:

```bash
router-actions.sh sessions control pause '<discovered-session-address>' --source-input '<input-id>' --source-run '<run-id>' --action-id '<stable-action-id>'
router-actions.sh sessions control continue '<discovered-session-address>' --source-input '<input-id>' --source-run '<run-id>' --action-id '<different-stable-action-id>'
```

Copy the address from discovery; catalogue IDs and peer addresses are refused. A Mac
controller uses the installed command on the Mac with its own admitted source pair.
This does not forward remote controls or change global Pause. Informational-only and
consultation-only callers cannot use it; the existing work-authority check applies.
Imported evidence, Canvas observation records, superseded bindings and withdrawn
handoff successors are refused.

The command uses the same owner action as Thinkering's Pause/Continue, with agent
origin, exact source input/run, acting session and target binding retained. The source
and action ID identify a retry; changing its target or action conflicts. The retained
control and event commit together. The original human route still records human origin
and continues to reject agent-injected author fields.

Pause saves deliberate suspension and discards queued automatic continuations using
the existing policy. It does not promise to interrupt a provider already running, nor
does it acquire an automatic release time. Continue clears that suspension, admits
held ordinary inputs through the existing queue and wakes normal execution. A receipt
proves the choice was saved; observe the exact provider run separately. A delayed retry
of an earlier control does not reverse a later saved choice. Usage holds remain separate
from deliberate Pause; this entrance adds no recovery policy.

## Outside agents

An agent launched outside Concierge has no accepted Concierge input/run pair. On the
server, it may use the installed helper without impersonating Tejas or creating a
requester session:

```bash
router-actions.sh external work-flow-supervisor capture -- "A message for the Inbox router"
router-actions.sh external work-flow-supervisor capture --id incident-42 --file /path/to/evidence.txt -- "Please route this"
router-actions.sh external work-flow-supervisor ask '<exact-discovered-session-address>' --action-id incident-42 --requested-effect work -- "Check this incident"
router-actions.sh external work-flow-supervisor get '<request-id>'
router-actions.sh external work-flow-supervisor withdraw '<request-id>' --ask-action-id incident-42 --action-id withdraw-incident-42
```

Names match `^[a-z][a-z0-9-]{2,40}$`. `ask` also accepts `--text-file` in place of
text after `--`; its action ID is stable across retries. Capture accepts a stable
`--id` of 1–200 letters, digits, dots, underscores, colons or hyphens. Repeating
the same ID, name and bytes returns the first receipt and starts no second router
turn; changed bytes conflict. Without `--id`, the helper creates a fresh random ID.
Capture enters the normal Inbox intake and starts its router turn. Direct asks use the normal recipient queue
and reply command. The outside caller polls `get`; no return input is delivered to
an imaginary session. The owner socket is root only. The old `test-capture` command
remains a path check by an agent already inside Concierge and starts no Inbox turn.
`withdraw` works only for that outside agent's exact unstarted request, using its
original ask action ID and a stable withdrawal action ID. It returns a retained
`canceled` receipt; a started or uncertain request is refused. The human obligation
remains open for reassignment. Repeat the same withdrawal command to read the same
receipt after a lost response; never submit a second ask to another provider before
the cancellation is confirmed.

The same root-only owner socket answers `GET /supervisor/ping` with process identity,
start time and installed release, which the outside work-flow supervisor uses to tell a
frozen owner from a working one. Its gateway adds reader capacity, reader health and bounded
logger counters, but does not answer on behalf of a frozen canonical owner; the supervisor's
own unanswered-ping deadline still controls recovery. Stuck work is watched inside Concierge, not through this
socket; see the shared wire contract.

## Outside requests

`sessions ask --outside --project <project> --session-name <title> --summary <line> [--thread <id>] -- <brief>`
is an ordinary request whose agent runs outside Concierge. The owner creates a normal Codex
session (Concierge's Codex default model, or the Codex alias given with `--provider`) and runs
each of its turns as the Codex command line, `codex exec --json`, in its own
`concierge-exec-<id>` system unit. Concierge reads the run's record but never writes to it,
times it out or pauses it: a Concierge restart, update or Pause all leaves it working, and only
Stop on its session ends it. The next Concierge takes the run back from its record like any
hosted run.

The rest is the request protocol unchanged. The agent is told to close the request with
`sessions reply` and to retry a command while Concierge restarts; its answers post to the named
thread and the requester is not woken; the managed Codex Stop hook finds the run by its Codex
thread and sends it back if it tries to stop owing a reply. If it stopped while that check could
not run (Concierge down or restarting), the owner admits one report-back notice into the same
conversation, and only a second silent stop is recorded as stalled in the thread. Follow-ups to
the session queue and run as the next outside turn (`codex exec resume`); an outside run cannot
be steered. The session view therefore advertises no live steering, and a waiting
message says why it will be read in the next turn. A human message accepted by an older
owner as steering but provably never sent is restored to that queue under its
original identity at startup, including when the outside run already finished.
Its history is Codex's own
record of the conversation.

Use it for work that changes Concierge itself or must outlive trouble in Concierge. It replaces
starting `codex exec` by hand as a background job or through a launcher script with a file watch
on its report. When Concierge cannot accept a request at all, the Codex command line on the
server remains the way in. Design notes: `bot/src/outside-codex.ts`.

## Exact Codex report-back recovery

For an open work request whose service report-back ended with an empty Codex completion, use the exact recovery entrance from the currently admitted work run:

```bash
router-actions.sh sessions codex-recover '<original-request-id>' \
  --source-input '<this accepted input ID>' \
  --source-run '<this native run ID>' \
  --action-id '<stable recovery action ID>'
```

Add `--inspect` for a read-only diagnostic under the same live work-authority
fence. It returns the exact selected service input and acknowledged source,
creation model/effort witnesses, current binding and controls, and a snapshot
digest covering the complete later accepted-input suffix (including held inputs
without turns), steering, owner events and current selected-request custody.
It exports counts and evidence references, never input text, another session's
obligation inventory or a replay capability. It writes no receipt, reservation or
queue state. The diagnostic always distinguishes unproved native interval coverage
and the missing native activity fence; its digest is not proof that a future
native start remains eligible. `continuation.authorized` remains false. A retained
reservation's status and input acknowledgement are reported separately from useful
work, which the inspector does not assess. The original execution entrance retains
its existing stricter guards; `--inspect` does not relax them.

The owned model-start guard records both allow and refusal decisions as
`model_start_guard` owner events, correlated by input, owner run/attempt, hook and
owned native turn, binding generation, model and policy. Requested turn effort,
binding effort and observed effort are separate: missing effective effort stays
null instead of being inferred from the binding. Failure to retain a known
conversation's guard decision refuses that prompt. No prompt or secret bytes are
logged. This evidence diagnoses this guard only; it does not attribute another
hook's result, provider cancellation or the historical stopping cause.

The [writing continuation diagnosis](../incidents/2026-11-13-writing-continuation-eligibility.md)
records the Medium legacy shapes, independent compaction evidence, reproduced
attempt-budget gap and remaining receiver-boundary prerequisite. It authorizes no
live recovery or change to any original writing obligation.

The source candidate also composes accepted-binding continuation, complete native
interval proof, common forwarding permits and a one-attempt dispatcher budget.
Its production entrance remains held on
`LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN` and
`FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN`. Original-source history and cold
construction are now source-owned per-operation checks, not unconditional
readiness flags. The common mutation ledger excludes supported managed hook
installation across the exact cold/configuration read and actual resume. Complete
projected pagination, process absence, idle, historical `notLoaded`, an installed
script or capability response cannot supply the missing native admission cut.
Nor can requirement publication prove exclusion of old application requests,
pinned helpers and configuration writers across first protection. Operational
preflight refuses that separate transition before any protected authority.
The [managed mutation contract](../architecture/CODEX-MUTATION-FENCE.md) owns the
writer inventory, Stop/terminal reconciliation and activation boundary. Internal
fixture success is not permission to recover a live conversation.

The owner selects only the service input `report-back:<original-request-id>`. It never resends the original request. This path requires verified work authority for the asking run, the retained human model choice for the same existing conversation, an open work request, the exact provider thread and current send controls, and owner evidence for every selected provider attempt. It then reads each exact native turn and all of that turn's item pages; only a terminal empty turn with no acknowledgement, output, tools, later admission, host activity, or other effect can be reserved. A separate empty turn from another accepted input is not attributed to this report-back. Unknown or incomplete evidence leaves the input in custody.

The accepted report-back ID is the durable deduplication key across action IDs. Reservation and requeue commit together. If the caller loses the receipt after reservation, retrying the same action returns its stored result; another action ID returns the same reservation. The original retained result remains unchanged, while a later execution attempt gets its own result identity and is surfaced by the existing result readers. This recovers only the report-back; its original request and any other obligations remain open until their own final receipts.

The incident artifact records the exact parent-controlled recovery command and historical evidence: [Codex empty report-back recovery](../runbooks/CODEX-EMPTY-REPORT-BACK-RECOVERY-EVIDENCE.md). It is not itself current eligibility proof; the live owner rechecks every guard at execution time.

## Disposable native Codex tests

Ordinary agent-created Codex sessions keep the shared daemon client and receive no fault control.
An admitted agent that needs one disposable acceptance target opts in at creation with a finite
future deadline:

```bash
router-actions.sh sessions ask --provider cx-sol --project slack-concierge \
  --session-name "Codex recovery target" --summary "Disposable native Codex recovery target" \
  --codex-native-test-until '<finite future ISO-8601 time>' \
  --source-input '<controller input>' --source-run '<controller run>' --action-id '<stable create action>' \
  -- 'One bounded benign checkpoint prompt'
```

The owner retains that deadline on the exact create input. Only that input's native Codex execution
uses a dedicated client to the existing daemon; the client object remains in host memory and is
never serialized. The owner accepts the exact `sessions codex-test stop|connection-loss` command
only for the marked create request and its source input/run pair. A connection-loss intent records
the execution, dispatch attempt, and connection generation before the host rechecks them and
retained Stop at the final cut boundary. Stop vetoes any later loss. A deadline disarms only loss
injection; exact-run Stop and ordinary recovery remain available after it. A proven no-effect
refusal does not spend the one-cut allowance. An ambiguous attempted loss does, and the same stable
action ID later returns its saved receipt without cutting again.

For a native account-switch acceptance, first keep the baseline continuation on its original
thread and shared client so it observes the existing guarded switch. Dedicated positive-loss and
matched Stop targets are separate, explicitly marked disposable creates; do not silently replace
the baseline continuation with a new conversation. The local fixtures establish owner and bridge
contracts only. They do not establish real daemon or provider behavior.

## Thread request returns

`sessions ask --thread <message-id>` delivers replies and notices directly to that thread.
Add `--return-to-requester` only when the requesting agent needs its own final or failure
input to continue. The choice is retained with the request and works for local and peer
recipients. Requests without a thread retain their ordinary agent-to-agent return.
For a ChatGPT question in a named thread, `--return-to-requester` is required:
the asking agent must receive the exact answer and record how it handled it
before its task can finish. The owner refuses a threaded ChatGPT ask without
that return.
`sessions get` still exposes every retained reply, outcome and attachment.

## Report evidence reads

`router-actions.sh reports capture <captureId>` reads one retained capture's exact words, source,
attachment list and held state by its ID (with or without the `capture:` prefix), at any age and
from any earlier Inbox session. Use it when a request cites his capture; the paged captures list
covers only the current Inbox's recent captures.

`router-actions.sh reports chain <accepted-input-or-request-id>` reads up to eight source links
from the owner. A bare UUID is a communication request ID. The JSON includes each accepted input's
session, origin, source input and run, capture marker, own files, exact words (`text`; a human's
words up to 65,536 characters, an agent or service input's up to 8,192, with `textTruncated`), and
the communication request's carried files. `inboxLinks` lists every exact Inbox obligation whose dispatch matches a request in
the chain, with its source captures. `direct: true` means the link belongs to the named request or
to a request sent directly from the named input; ancestral links are labeled `direct: false`.
The Inbox's link can name several human reports across topics. The legacy `resolvedCapture` and
`carriedReports` fields preserve the attachment fallback for unlinked historic sends.

`router-actions.sh reports window <since-UTC> <until-UTC>` reads the half-open interval of accepted
in-app reports and human inputs. Times are whole-second UTC, for example
`2026-11-04T06:00:23Z`. Each report has its linked communication requests, their settlement,
target session, and exact thread-post event IDs and times. An absent communication row has
`known: false`; an open row has `known: true` and `outcome: null`. The read refuses a ledger
with no accepted inputs, an invalid range, or more than 5,000 rows in a collection. A refused read
is never a clean zero. Both commands use the same authenticated owner entrance as session reads,
including from a runner where the ledger file is hidden; the query runs in the isolated read
process. The owning contract is [Runners](../architecture/RUNNERS.md).

## Waiting for a local process

Use `router-actions.sh wait --pid <pid> [--pid <pid> ...] [--timeout 30m]` when
an agent must wait for a shell it started. It checks exact process IDs and returns
when all have exited. A timeout exits 124 and names any still-running IDs. The
pre-command guard refuses a loop around a full-command process-name search,
because such a loop can match itself and hold a run open indefinitely.

## Reading his texts (Mac)

`router-actions.sh messages [--with <number, address or chat name>] [--q <words>] [--days <n>]
[--limit <n>]` answers JSON with his texts, received and sent, newest first (default 7 days,
50 shown messages; at most 365 and 500). For older group or direct
conversations, first use a named read to obtain the exact `chatGuid`, then use
`router-actions.sh messages --chat-guid <guid> --from YYYY-MM-DD --before YYYY-MM-DD
[--q <words>] [--limit <n>]`. The dates are UTC; `from` is inclusive, `before` exclusive,
and one request spans at most 45 days. The exact GUID selects only that conversation.
Divide a longer history into dated requests; `window.truncated` and
`olderThanThisNotRead` identify a window that needs narrowing. Shown messages carry their
Messages GUID as `id` and their `chatGuid`; `chats` gives shown conversations' exact identifier
and participant addresses when Messages has them. Withheld messages have no ID or text in the
answer. These identities describe this Mac's Messages database.

A text that looks like a one-time code, a reset or a
sign-in link is shown only when thnkr.ing's rule allows it
[decision: codes-hidden-only-for-money-and-identity]: the reader sends those texts (never others)
over `ssh remote-box` to thnkr.ing's `POST /codes/decide`, which applies his allow and hide lists
and the protected accounts (see thnkr.ing's AGENTS.md), and hides every one it gets no answer for
(`codeRuleUnavailable` says so). A shown code carries `codeShown {category, service, rule}`.
Hidden ones are counted in `withheldCount` and `withheldByKind` over the same stretch of time,
`withheld` lists the newest 200 by sender, time and kind, and a search never matches against
their words (that would let a search spell a code out). `window.truncated` says when the limit
stopped the read before the requested days. Every completed read is logged to
`diagnostics/messages-reads.jsonl` under the state directory, without message words, and
thnkr.ing logs each decision too. It runs only on the Mac; the server answers
`MESSAGES_NOT_ON_THIS_MACHINE`. Checked 2026-10-07 on his real texts: an Amazon sign-in code was
shown as an ordinary site and a T-Mobile code stayed hidden as his carrier.

Pictures and files sent in texts: a shown text lists `attachments` as `{id, type, name, bytes,
onThisMac}`. `router-actions.sh messages --attachment <id> --to <folder>` copies that one
attachment into the named folder (created if missing), converting HEIC/HEIF photos to JPEG with
`sips`, and answers `{exported: {path, type, convertedFrom, bytes}}`; agents then open the copy
with their ordinary tools and never touch the Messages folder. The code rule extends to
attachments: a text whose words look like a code, reset or sign-in link (even one thnkr.ing would
show), or any text from an automated or short-code sender, lists no attachments and its
attachment ids answer `ATTACHMENT_WITHHELD`. Pictures from a person's number or address, or ones
Tejas sent, are ordinary. `ATTACHMENT_NOT_ON_THIS_MAC` means Messages has not downloaded the file
(it may be in iCloud only). Every export and refusal is logged to the same diagnostics file.

It is the sanctioned way in, not the only one. The pre-command guard refuses any call that names
the Messages folder, chat.db or Notification Center's store, or a `mac-screenshot app Messages`,
from either machine [decision: codes-hidden-only-for-money-and-identity]. That includes commands that only
write about them, such as a commit message or a session message: every exemption tried opened a
read (attaching the database with `--file`, `git commit -F <(…)`), so such text goes in a file
passed with `git commit -F` or `--text-file`, whose contents are not inspected. A command that
builds the path at runtime (`cd ~/Library/Mess*`, a recursive search of all of `~/Library`), a
screenshot of the Messages window by its window number or by part of its name (`mac-screenshot app mess` or `app sms`), or a whole-screen capture that catches a
notification banner still gets through, because Mac agents keep Full Disk Access and screen
recording until Tejas decides otherwise (security review, 2026-10-07).

Measured on 2026-10-07 over a year of his texts: of 601 texts from short-code and named senders,
201 were withheld, and none of the 400 shown contained a code when read with every digit masked
(they were events, bills, deliveries and reservations). Texts from ordinary numbers are withheld
when a code word sits beside a 4–8 digit number (131 in that year, mostly banks texting from
long numbers and codes he forwarded), which errs toward hiding.

## Current native routing

`sessions snooze --until <ISO time, at most six hours ahead> --reason "<why this can wait>" <source-flags> --action-id A` lets an agent on a crowded machine (the Mac, when it told the agent so at turn start) wake itself later: it queues a scheduled continuation of the same session, shows "Snoozed until <time>: <reason>", and keeps every open request open with its due time moved past the wake. Refused for his direct messages and the Inbox router, when the machine is not crowded, and beyond six hours; end the turn after it. See [turn lifecycle](../architecture/TURN-LIFECYCLE.md#paced-starts).

For resource-heavy phone work that Tejas authorized only while he sleeps, create a new banked coding session with `sessions bank --quiet-only` and the usual project, session name, summary, source pair and action ID. The saved-work quiet hours and time zone in thnkr.ing Settings govern the window. Concierge refuses a claim outside that band or during its last five minutes, and asks an active run to stop at that early cutoff; a continuation keeps the same choice. Inside the band it starts whenever an account has room above the reserve, even while other agents run. Each night it does not start, you are woken with why; `sessions saved list` shows the current reason as `waitingBecause`. Ordinary `sessions bank` retains its allowance-reset behavior. `sessions cancel <request-id>` withdraws a queued saved turn; `sessions saved cancel <turn-id>` remains the direct saved-work control. Check `sessions saved list` after cancellation. See [session ownership](../architecture/SESSION-OWNER.md#one-execution-owner).

### Standing agents

Consult the workspace organizer, then create a continuing job with `projects new <name> --purpose "<one sentence>" --consultation <request-id> <source-flags>`,
write its project's `AGENTS.md`, and add one role row to the standing-agent list. `sessions agents`
then shows every role's job, folder, bound session (title and provider/model), repeating schedule,
armed watches and last run. It also shows unowned repeating schedules and this machine's systemd
timers, or an explicit unavailable state on a Mac or host without systemd. The same read is
`GET /sessions/v1/presentation/agents` for Thinkering.

`sessions ask --role <role> --summary "<one line>" --action-id A -- <text>`
uses that session. If the role is unbound, it starts one in the declared agent project and binds
it at creation, with the role's description as its session name; `--session-name` overrides that
name for creation. `sessions agents bind <role> <session-address> <source-flags> --action-id A`
moves a role's binding to an existing non-archived session in its exact declared folder. The
source and action ID make retries idempotent. Moving a bound session to another folder clears its
binding. The role table in `bot/src/standing-agents.ts` is the sole home for these folders and wake facts.
Binding `inbox` makes that session the Inbox router, exactly as an accepted provider handoff does:
new captures, his thread replies, thread-named requests (`sessions ask --thread`), topic commands
and Inbox reads go through it, and it carries the former router's open attention. Every session
ever marked as the Inbox stays part of the one Inbox, so their threads and topics remain usable
from the new router. Inputs already queued on the former router stay there; the bind receipt lists
them under `formerRouter.stillQueued`. A provider handoff moves them; otherwise read and route them
by exact id. `bot/src/inbox-lineage-sql.ts` holds the one definition of the current router and of
the Inbox's sessions.

`sessions topics message <messageId>` returns one Inbox message's words, author, time,
attachments, thread root and topic: a capture, his reply, an agent's post, result or routed request,
or a request input that a topic request names as its source or dispatch. Topic reads carry ids and
short excerpts; this is the read for judging the message itself. Its `from` and full `author`
resolve the current author, including a later correction to an originally human-origin input;
an unproved user-role message reports unknown rather than Tejas.
`sessions context` and the session view expose only a session's explicit role binding.

`sessions schedule --role <role> --at <future ISO-8601 time> [--every-ms <interval>] --summary "<one line>" <source-flags> --action-id A -- <text>`
queues one firing in that bound session, or creates and binds the role's session first. The bound session may run it for its own role: its firing is then a plain scheduled input in itself, with no request to itself and nothing returned. A repeating
schedule keeps firing there. While one repeating firing for the role is queued, another repeating
schedule is refused with its exact turn ID; change its time in Thinkering Saved work or cancel it
with `sessions saved cancel <turn-id>` before replacing it. That control cancels only the named
queued turn; on a repeating schedule it also prevents another firing from being booked. Other
scheduled turns in the same session remain queued. `sessions schedule --project` remains available for
registered projects. The read caps repeating schedules at 32, watches per role at 20, and host
timers at 128; its coverage field says when a cap was reached.

For a daily wall-clock delivery, use `sessions schedule --daily-at HH:MM --time-zone America/New_York` with the same project or role, provider, title, summary, source and action fields. Concierge computes the next local date and retains the IANA zone on the repeat; it recomputes each later firing from that date, so daylight saving changes do not move the displayed local hour. `--daily-at` is exclusive with `--at` and `--every-ms`. A spring gap fires at the first valid minute after the requested time; a fall repeated hour fires at its first occurrence, once for that local date. `sessions saved list` and the agent view expose `dailyLocal` and the next UTC instant; the daily interval remains in the compatibility field so existing clients still identify the schedule as repeating. To migrate a queued repeat in place, use `sessions saved daily <exact queued turn ID> --time HH:MM --time-zone <IANA zone> <source-flags> --action-id A`. This changes its root recurrence and one queued firing atomically without creating or replaying a session input. It refuses a historical firing, a manually started firing or an ended repeat. The same action ID returns the same result.
The existing Saved work time control keeps working after migration: choosing a new next run also changes that repeat's wall time in its stored zone, while retaining its expiry. The saved UTC instant remains the next firing the user selected.
On a runner, the role's declared workspace-relative folder (such as `agents/concierge-repair`)
must resolve to that runner's registered project at that exact folder before a wake is saved.
The returned project identity belongs to the existing bound session; a nested agent folder does
not cause a new session or a fallback to a similarly named root project.

To stop any repeating schedule, run `sessions cancel <request-id>` on the request that created it, or
`sessions saved cancel <turn-id>` on its queued firing. Either one withdraws every queued firing and
books no more; a firing already running finishes. The request names only the first firing, so the
saved-work step that books each next firing checks whether the schedule was dropped or its request
cancelled. Until 2026-11-06 a cancelled request left later firings running. `sessions saved list`
shows each armed schedule's next firing, turn ID and interval.

A repeating schedule created with `--expires` ends at that instant: the last firing due before it
runs, no firing is booked at or after it, and every firing carries that same expiry. Until
2026-11-11 each firing moved the expiry one interval later, so a schedule with an expiry never ended;
a firing still queued from that time is withdrawn when it comes due past the original end.

New repeating schedules and renewing file watches require both the requesting session and
the scheduled session, where applicable, to belong to a registered project. Placement under
`agents/`, `canvases/` or the workspace root does not change eligibility. A continuing role
still has its own declared project and bound session. Place a new project with the workspace
organizer, then use `sessions ask --role` for a declared standing role. Until the existing roles are bound, journal
observations use the known keeper `concierge:4571`, and repair notices use the exact-title repair
session in `agents/concierge-repair`. Neither fallback chooses the newest session in a folder;
both stop once their roles have a binding. Bind the existing roles after installation rather
than sending their first request through an unbound role.

New project creation runs on the server, where the workspace organizer's consultation
is retained. Share and status use the local Concierge socket on either machine:

```bash
router-actions.sh sessions ask --role workspace-organizer --requested-effect work --summary "Place a writing project" --action-id <stable-action> -- "Place canvas-essay-notes for this purpose and writing template: An essay exploring how Canvas changes drafting."
router-actions.sh projects new canvas-essay-notes --purpose "An essay exploring how Canvas changes drafting." --template writing --consultation <completed-request-id> --source-input <current-input> --source-run <current-run>
router-actions.sh projects share life-logistics --to mac
router-actions.sh projects status life-logistics --to mac
router-actions.sh projects cancel life-logistics --to mac  # only while still recorded
```

The workspace organizer is a bound standing session on the server. Ask it for a placement
before creating a project. Its completed work reply is one JSON object with the exact
`project`, `purpose`, optional `template`, and `group` (a one-level plain folder name,
`null` for the workspace root, or the established `agent-ecology/expertise` lab group).
For the example above, a grouped answer is
`{"project":"canvas-essay-notes","purpose":"An essay exploring how Canvas changes drafting.","template":"writing","group":"canvases"}`.
The decision is read from the organizer's own words: the required "What came before" lead a
first reply carries (recorded as its own reply field) is set aside, and the one JSON object may
stand alone or among the organizer's prose or a fenced block; two candidate objects are refused
as ambiguous. The Canvas policy answer below is read the same way.
Pass that request ID with `--consultation` and the creator's current source input and run. The creation API checks that the bound organizer
answered the asking session, completed the request, and accepted these exact fields before
creating any folder. It reserves that exact answer for one project, allows retries of the
same unfinished creation, and refuses a new attempt with an answer older than a day. It
refuses missing, unfinished, used or mismatched answers. The peer order
carries only the group name, so each machine derives its own path. A peer with the older
setup contract waits for an update rather than putting the project in the wrong place.
The child name is the registered project name on both machines. Existing projects stay at
their current paths because sessions and transcripts retain that identity.
If the organizer has not answered or is not bound, creation refuses before making a folder;
the caller can retry after the consultation is complete.

For a new Agent Ecology expertise, ask the bound organizer for the exact project name,
purpose and `agent-ecology/expertise` group. After its completed JSON reply, create it with
`projects new <name> --purpose "<one sentence>" --here-only --consultation <request-id> --source-input <current-input> --source-run <current-run>`.
This places the separate registered project at `agent-ecology/expertise/<name>` on the
server and creates the private `tejasdc/expertise-<name>` repository used by the lab.
The lab's own repository must already exist and ignore `/expertise/`; the command refuses
otherwise. The lab currently lives on the server; sharing an expertise to the Mac later
requires the lab parent there first. Peer setup waits for a Concierge version that understands
this nested group, so an older Mac cannot clone it into the wrong place. After creation, apply the expertise
standard using Agent Ecology's `scripts/apply-expertise-standard.sh` and commit that
expertise's own changes. The standard's authority remains Agent Ecology's
`docs/expertise/STANDARD.md`; the project command only supplies custody and placement.

Thinkering's Canvas does not impersonate an agent turn or ask the person to choose a project.
The bound workspace organizer answers one consultation with the exact JSON object
`{"group":"<group>","template":"<template>"}`. `projects canvas-policy --consultation <request>`
derives the policy only from that retained answer; the caller cannot substitute values. Each
revision keeps that organizer reply and its input and run. `POST /sessions/v1/canvas-projects/ensure` accepts a stable board
identity and current title, freezes the first project choice, and creates from the policy revision
available at that moment. A default title uses a stable board-derived folder name; later renaming
does not move the project, as the workspace organizer policy says a title change must not silently move a folder that sessions or links may use. The browser sends each later title revision under a distinct action identity, while the owner records it only with a newer board revision clock; the project catalogue shows that current Canvas title beside the stable folder name. `GET /sessions/v1/canvas-projects/:board` returns `pending`, `ready`, or
`failed`. `ready` means the server scaffold exists and the Canvas can use it; private GitHub setup
and the durable Mac order continue after that local boundary. A Mac path appears only after that Concierge confirms
the registered peer project. A later remote failure stays visible without making the local Canvas unusable. Reusing an existing project requires its explicit registered name and
optional inside folder; title similarity never attaches a board to a project.
For a deliberate retrofit, `projects canvas-bind <board-id> --title <title> --existing <project>
[--inside <folder>]` records that exact association without creating or moving a project;
`projects canvas-status <board-id>` reads its retained setup state.

`--template brainstorm|writing|design` lays a project template into the new project before its
first commit: a threads file, research dossiers and an `agents/` folder of standing agent
specifications (research, co-writer as a fork of research, interface), growing with each template.
See [project templates](../plans/2026-10-29-project-templates.md).

An agent appends its exact `--source-input` and `--source-run` pair to `new` or `share`;
a terminal user omits it. A new project gets the canonical instruction file, its Claude
symlink, docs index, Git ignore (which also keeps the machine-local notes link out of Git) and a notes link when this machine has a vault root. It is
committed and pushed to a private `tejasdc` GitHub repository before the peer order is
recorded. A repeated `new` completes an interrupted creation. `share` requires the same
named origin and a branch already pushed there. The other machine may be asleep; status
shows the retained order and its result when it arrives.
Cancellation is accepted only before any delivery attempt; it never undoes a peer checkout.

New work goes to Thinkering native sessions, including requests arriving through
the retained DM. Agent Slack post/resume/upload/request ingress and automatic
legacy routed recovery are retired; those commands refuse before publication.

When a Claude or Codex design is fixed and the implementation needs a separate
worktree, use `sessions implement --project <registered-project> --session-name
"<task>" --summary "<acceptance criterion>" <source-flags> --action-id <stable-id>
-- <design and acceptance criteria>`. It starts Sonnet for a Claude designer or
Luna for a Codex designer by default; `--provider` may name a suitable cheaper
tier in the same provider. The implementation request returns to the designer
for review. `sessions --help` and the per-run request protocol carry the exact
command. Use the same action ID on retry so the worktree and request stay one.

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
session with automatic provider selection:

```bash
router-actions.sh sessions ask \
  --project thinkering --session-name 'Startup responsiveness' \
  --source-input '<inputId>' --source-run '<runId>' --action-id '<stable-action>' \
  --requested-effect work --capture-id '<retained-captureId>' --text-file '<brief-path>'
```

The retained Slack source pair may replace the native pair. Never mix them.
The owner mixes Claude and Codex using current usable account headroom when no
provider is supplied. For a bounded task that fits one focused session without
live steering, `--small-task` also admits Google. An explicit human provider or model choice stays pinned;
no escalation or fallback is silent.
`sessions projects` lists current canonical project folders under the workspace root:
each has a real `AGENTS.md` and Git root. It no longer depends on the retained
Slack `channels` table. `--project` resolves one exact listed name or cwd at the
owner; it does not accept an arbitrary cwd. `D0BMWUJ3RD5` is a retired DM folder,
not a routing target. Concierge implementation belongs to `slack-concierge`;
Thinkering implementation belongs to `thinkering`. If a project is missing or
unclear, ask instead of selecting an unrelated folder. The native Inbox router
itself uses Claude Opus with 1M context in `slack-inbox`, while newly created
destination sessions use the automatic choice. Alias resolution pins the exact
model and effort in native session metadata and queued execution. `--session-name`
sets the canonical title. No Slack root is created and no human origin is forged.
An explicit human session/provider/model/effort choice takes precedence.
Existing addressed sessions preserve their provider/project; provider selection
creates a new session. Do not alter or replay already-running work because of
this routing default. ChatGPT uses `--provider chatgpt` without a project; its `--effort` is a
ChatGPT thinking level (below).

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

An agent carrying a work request can switch the saved Codex account on this server
or the Mac through `sessions auth switch codex <saved-profile-id> [--machine mac]`
with its exact native source pair and stable action ID. This invokes the existing
guarded Accounts operation: running Codex turns prevent the move, Codex proves the
new login, and a failed proof rolls back. The command retains an agent-authored
receipt; an uncertain operation is inspected, never replayed under the same ID.
The immediate reply includes that retained operation ID and keeps the switch result's
existing `status` and `detail`. Exact operation reads and receipt pages derive their
existing operation state from that structured status: an applied switch is completed,
a guard refusal is failed, and an unconfirmed switch is uncertain. Historical results
are shown from their original saved reply, without replay, migration, or a new settlement
record. A same-action retry returns the same operation identity and result.
See [provider usage](../architecture/PROVIDER-USAGE.md).

`sessions history-storage claude|codex <source-flags> [--after <next filename>]
[--limit 1..2000]` reads allocated and logical bytes for one page of private
history cache files through the authenticated owner. It returns the observation
time, exact file count scanned, eight largest files in that page, and
`complete`/`next`. Sum pages until `complete` before reporting a total;
a missing directory reports
`exists:false`, while a read error is an error, never a zero-byte result. The
Claude scope is snapshot SQLite files; the Codex scope is window JSON files.
Sidecars, runner mirrors and the presentation ledger are separate allocations.
This command reads file metadata only and never returns transcript content.
The guarded cutover and its backup/readback gates are in the
[history object plan](../plans/2026-11-12-concierge-history-object-retirement.md).

### Resuming a frozen ask

A run that persisted an ask (source pair, action ID, exact payload) and ended before knowing
whether it was admitted can be resumed by a later run of the same session: repeat the identical
`sessions ask` with this run's own `--source-input/--source-run` plus
`--resume-source-input <original input> --resume-source-run <original run>`. Concierge returns
the request already admitted under that original pair and action, or admits it once under the
original identity. A changed payload is refused as an idempotency conflict; the original run must
have ended, and the input must belong to this session. Local ordinary asks only.

### Provider-change handoff

When Tejas asks that ongoing work continue on another provider or model, hand off the
existing session instead of withdrawing its requests or creating replacement work. Use
the exact predecessor address returned by `sessions search` or `sessions context`.
The successor stays on the same machine and in the same project folder. Choose a coding
provider alias; ChatGPT cannot be a successor because it cannot acknowledge the handoff.

```bash
router-actions.sh sessions obligations '<predecessor-address>' <source-flags>
router-actions.sh sessions handoff '<predecessor-address>' --provider cc-fable \
  --reason 'Tejas requested Fable for this work' <source-flags> --action-id A
# Read the returned handoff ID and inventory digest. The successor, from its own live run:
router-actions.sh sessions context '<predecessor-address>' <successor-source-flags>
router-actions.sh sessions obligations <successor-source-flags>
router-actions.sh sessions handoff accept '<handoff-id>' --digest '<inventory-sha256>' \
  <successor-source-flags> --action-id B
```

The proposal starts a successor with a handoff brief. Until it accepts, the predecessor
keeps its obligations and can keep working; `sessions handoff withdraw <handoff-id>
<source-flags> --action-id A` ends an unaccepted proposal. The successor must read the
predecessor's context, inspect the exact inventory and acknowledge its digest. If
acceptance returns a changed inventory, inspect the returned items and accept its new
digest. On acceptance the owner moves open return and reply obligations, watches and
safe never-started queued inputs together. Existing child requests keep their IDs and
continue in place; worktrees are referenced and untouched. `sessions obligations
[<address>]` shows the outstanding items, lineage and current holder on either side.
The superseded session can read and close its current turn, but further owner writes are
refused with the successor's address. `sessions cancel <request-id> --reason
provider-change` is refused with the exact handoff command instead. Ordinary
`sessions cancel` may include another `--reason`; only `provider-change` changes its behavior.
The [session owner](../architecture/SESSION-OWNER.md#provider-change-handoff) owns the
transfer and fencing contract.

**Watching without waiting.** `sessions watch file <absolute-path> --until <ISO time|90s|30m|2h|1d> [--renew]`,
`sessions watch command --cwd <dir> --until … -- <argv…>`, `sessions watch list` and
`sessions watch cancel <watch-id>` (each with the run's `--source-input/--source-run` and, except
`list`, a stable `--action-id`) wake this conversation once, when the file or directory changes
(deletion counts), when the command finishes, or at the deadline (at most 30 days), with no model
running meanwhile. One service input `watch:<id>:<fired|expired|failed|cancelled>` arrives saying
what was observed and any observation gap. Local to this machine. See
[watches](../architecture/WATCHES.md).

For an exact predecessor file watch and its already registered renewing recovery successor,
use `sessions watch inspect-pair --old <id> --new <id>` and then
`sessions watch reconcile-pair --old <id> --new <id> --inspection <returned-inspection> --action-id <stable-id>`,
each with the current native source input/run. These commands prove retained work delegation
and recovery custody, expose metadata only, and quietly retire only an active redundant old
watch or its series successor. Terminal firings are preserved. Ordinary list/cancel do not
gain cross-session authority. See [exact-pair recovery custody](../architecture/WATCHES.md#exact-pair-recovery-custody).

**Opening a link on his Mac.** `sessions open <http(s)-link> [--on mac] [--browser chrome|safari|default]`
with the run's source pair and a stable `--action-id` opens the link in his browser on the Mac with no
session; queued while the Mac sleeps, with one service result when it later opens or expires. See
[peer instances](PEER-INSTANCES.md#opening-a-link-on-his-mac-without-a-session).

<a id="discussing-in-the-lab"></a>
**Discussing in the Lab.** `sessions board read|thread|post|claim|reveal|close|product|cite|link …` with the
run's source pair (and a stable `--action-id` for changes) reads and writes the lab record in thnkr.ing (/lab):
threads, and the findings, decisions, skills and designs they produce, each with a lasting address (`lab:<handle>`,
`lab:<handle>/<entry>`, `.<paragraph>`). `--mention <address>` wakes that session once with a notice that owes no
reply; replacing a record (`product --supersedes`) notifies its author. `read --address` returns the exact words at
an address. Mac sessions use the authenticated Concierge peer channel to make Lab calls on the server;
the server holds the agent key, while thnkr.ing verifies the Mac's own input and run through the
federated session owners. The Mac session remains the author and delivers mentions from its own run.
If the peer is unavailable, the command fails before reporting a Lab result and the same action ID
can be retried. Route contract:
thinkering docs/plans/2026-10-08-lab-record.md; design: [the lab space](../plans/2026-10-08-lab-space.md).

`board thread [<board>] --kind proposal --title T --blind <key> --member <address> ... -- <words>`
passes the blind group key to the Lab record; the record keeps each arm's discussion private to its own
participants until every thread in the group closes. Omit `--blind` for an ordinary thread. A Lab read
refusal is returned to the command with its HTTP refusal status and message, without a retry.

**A design he reviews section by section.** `board product --product design --title T --from "lab:<thread> :: <why>"
--text-file <markdown>` publishes a living design into thnkr.ing's Lab (Designs in review): the text passes through
unchanged, and the record refuses it without `## ` sections separated by blank lines or without a `derived-from` link
to an open Lab thread whose sessions answer him (its sentence is shown as the refusal). `--inbox-session <session>
--inbox-message <id>` names the Inbox thread the work belongs to; the record files one line there about the publication
as the publishing agent's words. Each section's address is `lab:<design-handle>.<passage>`, the passage number of its
heading. His asks and comments on a section are posts in that thread carrying the section address; answer one with
`board post --thread <thread> --reply-to <his entry address> --target lab:<design-handle>.<passage> --intent answer --
<words>`, which lands under that section and turns it answered. Words he said in an Inbox thread are placed at a
section with `board post --thread <thread> --target <section> --speaker tejas --his-input <his Inbox input id> --intent
ask|comment -- <his words verbatim>`: the agent stays the author of record and the record refuses it without the
source (never write through his door); add `--inbox-session <session> --inbox-message <id>` so an agent's later answer to
that placed post is also filed into his Inbox thread as the agent's reply. `board verdict --design <handle> --verdict
approve|revise|stop [--scope <text>|none] -- <words>` records his per-version verdict; approve is refused while a section
is contested or holds an unanswered ask, and the refusal lists those sections with why. `board cards --design <handle>
--inbox-session <session> --inbox-message <id> --json-file F` (design author only) files the author's section cards, each
`{section, claim, consequence, recommendation, alternative, question}`, as a post under its section and one line into
the Inbox thread. `board read --address lab:<design-handle>` prints the record's review: each
section's state (`missing`, `open`, `asked`, `answered`, `accepted`, `contested`), his entries under each with the
replies nested, the per-version verdict, and `owed`, the sections still waiting on an agent. A revision is a new design
with `--supersedes "lab:<old> :: <why>"`. Design and acceptance: agent-ecology
docs/plans/2026-10-13-codiak-participation-interfaces.md; route fields: thinkering
docs/plans/2026-10-13-living-design-review.md.

For a design argument, an agent posts its own challenge with `board post --thread <thread> --target
lab:<design>.<exact-passage> --intent challenge --action-id <stable-id> -- <objection>`. This registers the original
entry and the exact passage in one Lab write. An answer does not settle the challenge. To propose or select a scoped
disposition, write a JSON object with `challenge`, `version`, `scope`, `kind`, `evidence` (Lab addresses), `nextActor`,
`nextAction`, `replaces` and `selected`, then use `board post --thread <thread> --target lab:<current-design>.<passage>
--intent disposition --disposition-file <path> --action-id <stable-id> -- <reason>`. Kinds are `pending`,
`observed-answer`, `narrowed`, `accepted-cost`, `withdrawn` and `reopened`. A pending investigation names its next actor
and action; an observed answer names the evidence it claims supports it. Any agent may propose (`selected:false`),
while the thread's decider or Tejas selects; only the challenger can withdraw its position. The current design view
includes registered challenges from earlier versions, including uncertain passage placements. A planned test is pending,
and a selected cost remains visible within its stated scope. These commands do not prove the cited observation answers
the objection.

Another Concierge instance is a peer: `sessions peers` lists them, and `--peer <instance>`
on `projects`, `search` and `ask` targets that instance's projects and sessions. A peer
request and its result destination stay here; the recipient on the peer replies with the
ordinary `sessions reply`. A named Inbox thread receives the result directly unless
the requester explicitly asks for a copy. See [peer instances](PEER-INSTANCES.md). Creating a session on a
peer needs `--machine-need "<what only that machine can do>"`; new work runs on the server.

A call that lands while Concierge restarts for an update waits it out (`ownerRestart`, 90 s;
the Stop hook's `ownerRestartInHook`, 15 s) in `bot/scripts/router-request-client.ts`. A request
that never reached the owner is sent again; one that may have reached it is sent again only when
the owner deduplicates it (every `sessions` change carries `--action-id`, and every `sessions`
call without one is a read). Otherwise, or when the budget ends, the command exits 1 with
`{"error":"owner_unconfirmed","retry":{"path","action_id","resend_is_safe"}}`: run the same command
with the same action id again, or check with `sessions get`. `projects new|share|cancel` carry no
identity and are never resent after a possible delivery. Thinkering applies the same rule to his
own changes (each carries a `clientActionId`) in its server's owner client and in the browser.

Each local candidate in `sessions search` and `sessions context` carries `workload`: context in use,
running or idle, the open Inbox topics it handles, and `forTopic` for your topic (`--thread
<message-id>`, else the topic of the message your work started from). The router chooses; the
receiving session judges fit ([session fit](../architecture/SESSION-FIT.md)):

```bash
# A new topic: a fresh session that starts with a pointer to the earlier one.
router-actions.sh sessions ask --provider cc-opus --project slack-concierge --session-name "Provider Accounts switch" \
  --consult session:… <source-flags> --action-id A --requested-effect work --thread <message-id> -- <text>
# A receiving session pushing back; the requester's answer opens with "Handed back (…)" and the fresh command.
router-actions.sh sessions reply <request-id> <source-flags> --action-id A --work-disposition failed \
  --hand-back not-my-subject -- "<what context I can give>"
# One answer to several requests from the same asker: one command, the same words to each.
# The owner gives byte-identical answers one return and one post in a thread (one notification).
# Each later request gets a bounded, owner-valid action identity derived from the command and request;
# a failed later delivery can be retried without replaying the first answer.
router-actions.sh sessions reply <request-id> --also <request-id> --also <request-id> <source-flags> --action-id A \
  --work-disposition completed --summary "<one line>" --all-done --checked "<what you saw>" -- <text>
```

What reaches Tejas carries its reasons, and the owner refuses it otherwise:

```bash
# A question: one line he can decide from (it opens his phone notice), his exact words that
# started the work, and what they leave open. Details and other news go in the text after it.
router-actions.sh sessions outcome needs_you <source-flags> --action-id A \
  --summary '<what he must decide and the result it depends on>' --only-he-can ambiguous --his-words '<copied from his message>' --why-not-answered '<what only he can decide>' -- '<the question>'
router-actions.sh sessions reply <request-id> <source-flags> --action-id A --work-disposition needs_decision \
  --summary '<what he must decide and the result>' --only-he-can ambiguous --his-words '<…>' --why-not-answered '<…>' -- '<the question>'
# Completed work: what was exercised on the real system and what was seen, or why nothing could be.
router-actions.sh sessions reply <request-id> <source-flags> --action-id A --work-disposition completed \
  --checked '<what you ran live, and what you saw>' -- '<the answer>'
```

His words are checked against the message that started the work and his other messages of the
last thirty days in this ledger; work that began on the other machine is taken as given. A
session in a writing project (the messaging agent) cannot send `--requested-effect work`.

An `only-he-can device` question may ask for one physical action in its first sentence,
including saying a named `Alexa, open …` launch phrase to an Echo. For example:
`Please say “Alexa, open thinkering box” to your Echo.` The reason field explains why
the agent route cannot perform this check. A server or simulator result does not establish
what the Echo heard or whether a capture reached the Inbox. Keep the source request open
until the physical attempt and its resulting capture or refusal are observed.

### Approval required by a permanent decision

An approval question uses the existing `needs_you` outcome or final `needs_decision` reply.
It carries `--only-he-can approval`, the decision ID, a named action, his exact words, and why
those words do not themselves approve the proposed action. The owner reads the installed
decision record (`~/workspace/decision-record`), requires it to be permanent and unsuperseded,
and requires the named action to appear, word for word apart from case and spacing, in the
record's `Needs his approval` section. It also accepts his words from that record. For
example, a change to disk priority uses `--decision-id machine-wide-resource-changes-need-his-approval`
and `--approval-action disk-priority`; signing off the agent-native protocols experiments uses
`--decision-id anp-experiments-wait-for-his-signoff` and `--approval-action 'run the agent-native
protocols evolution experiments'`. A refusal lists the actions the cited record reserves.
A permanent decision whose words reserve a new action gets that action in its record
(`decision new --needs-approval`, or an added section); no Concierge change is needed. Other
permission, approval, and design questions stay refused [decision: act-then-tell]
[decision: machine-wide-resource-changes-need-his-approval] [decision: anp-experiments-wait-for-his-signoff].

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

A `post` or `reply` whose text names an absolute or `~/` file path the file viewer would refuse
(missing, a hidden or secret file, outside the workspace) is still sent, and its result carries
`unopenable_links` and a `warning` printed on stderr, judged by the same read the viewer makes.
Act on it: move the file somewhere it opens, or send the corrected path.

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

For explicit human intent such as “ask ChatGPT for this information,” and for research and
second opinions (the model-selection skill's "big guns", [decision: chatgpt-pro-is-the-big-guns]),
the admitted agent uses the same ask command with `--provider chatgpt` instead of an address:

```bash
router-actions.sh sessions ask --provider chatgpt [--effort light|medium|high|extra-high|pro] \
  [--session-name '<title>'] --source-input '<inputId>' --source-run '<runId>' \
  --action-id '<stable-action>' [--file <path> ...] -- '<authorized question>'
```

`--effort` is ChatGPT's thinking level (`CHATGPT_THINKING_LEVELS` in `aliases.ts`), default
`pro`, ChatGPT's Pro model on Tejas's own subscription. It is stored as the new session's model,
so the admission names it and Thinkering's browser sets ChatGPT's power slider to it before
sending. `--file` attaches any file type. A Pro answer can take an hour; the request returns when
ChatGPT finishes. The browser is remote-box's always-running real Chrome
(`docs/chatgpt-browser.md` there), which Thinkering keeps signed in.

`--chatgpt-project <https://chatgpt.com/g/g-p-<lowercase-alphanumeric>/project|g-p-id>`
selects an exact native ChatGPT project, separately from the development `--project`.
It accepts ordinary `--effort` (agent default `pro`, `--his-chat` default `extra-high`); its retained model is
`[tejas:]project:<g-p-id>:<thinking-level>`. The browser confirms the selected project
before sending. An explicit project overrides the default Agents project or ordinary chat
destination without changing whose chat it is. Its displayed agent name is `ChatGPT · Pro`
(or the selected thinking level), rather than the internal project destination.

`--gpt` refuses ahead of the December 11, 2026 custom GPT retirement and points to
`--chatgpt-project`; the two flags cannot be combined. The canonical owner also refuses
new GPT destinations from old/direct clients and new messages to retained GPT sessions.
There is no silent ordinary-chat fallback. Historical GPT metadata, reads, receipts and
recovery of acknowledged/dispatched runs remain intact; do not replay them to migrate.

Native ChatGPT projects supply first-party instruction context on the existing browser
channel, with an explicit destination and normal thinking levels. Doing nothing retains
a retiring dependency; waiting for an unknown third-party plugin has no verified delivery
date or instruction-custody guarantee. Projects do not recover private GPT configuration:
the third-party Dating coach GPT (`g-R85Fq7o6n`) returned `instructions:null`, so its private
instructions have not been migrated or reconstructed.

The exact Slack source pair works too. The owner atomically creates one native
ChatGPT session and agent-origin first input with the existing request/return
obligation. The receipt retains `request_id`, `operation_id`, `target_session_id`
and `target_input_id`. Use an existing discovered address when the user selected
an existing conversation. An unavailable capability returns a durable failure;
an uncertain start retains its evidence. Neither substitutes another provider
nor creates a replacement session on retry. ChatGPT returns through the service;
it receives no outbound session tool. The asking agent selects the exact task
with `--for-task` when the source is a human input or holds several tasks. The
return includes the exact `sessions answer` command and answer event ID. A
failed or ambiguous attempt leaves the question open for exact receipt
recovery. See [ChatGPT answer obligations](../architecture/CHATGPT-ANSWER-OBLIGATIONS.md).
Ordinary-language interpretation remains in the existing application
instructions, with no second intent recognizer.

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

A request carries its sender's authority unless the sender narrows it. Without
`--requested-effect`, the owner records `work` when the sending run holds work
authority (a message from Tejas, or a work request, anywhere in that run) and
`informational` when the run was only asked questions, when the sender is a
writing session, or when the recipient cannot take work (ChatGPT,
consultation-only, archive history). Pass `--requested-effect informational` to
ask a question only. Authority is judged over the whole sending run, not the
message that opened it: when the cited source is a question but Tejas's own
message (or a work request) was steered into the same run, the request is
recorded on that message, and the recipient sees his request as its origin.
A run holding only questions still cannot send work, which is what stops a
question from turning into a work order further down a chain.

Before October 8, 2026 an unmarked request was information-only and nothing
warned the sender. A display fix came back designed but unbuilt (September 18),
and the agent-science-lab coordinator's requests to three builders were
declined until resent; its resend was then refused because the run had been
opened by a planner's question even though Tejas was talking to it in that run.

Every `ask` requires its recipient to close it with `reply`. Writing "no reply
needed" in the body does not settle it; `sessions cancel` can withdraw a request
the sender no longer needs. A named Inbox thread receives the answer and any
overdue notice directly unless the sender explicitly requests its own return.
Send information a recipient must act on as an `ask` and accept that it owes a
reply, and do not open one purely to inform.

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

Lab comments share their discussion. To answer a specific comment, use `sessions board post --thread <handle> --reply-to lab:<handle>/<entry>` with the usual source and action flags. The record resolves the parent and refuses a different thread or a hidden parent; mention notices include this reply command. Omit `--reply-to` to add a top-level comment.

On the server, the launcher sends Lab board commands to the installed current owner, including when the agent session started before a deployment. The older parser pinned to that session cannot know a new board option. Keep other session commands on their existing routing unless their contract specifically requires the current owner.

## Question expiry recovery

A `completed` or `failed` final reply expires only questions whose recorded dispatch ID matches
that reply. A same-session question without that link stays open for its exact request or an
explicit Inbox settlement. For an older sibling expiry, use the supported exact-record repair:

```bash
router-actions.sh sessions topics question restore '<question-id>' --dispatch '<erroneous-finishing-dispatch>' --expected-revision '<current-revision>' --source-input '<input-id>' --source-run '<run-id>' --action-id '<stable-action-id>' -- 'Why this exact sibling question is being restored'
```

The Inbox owner checks the retained expiry event, preceding question snapshot, current revision,
open topic and the question's own open dispatch-linked request. This restores the same stored
question silently and keeps its revision, timestamp, source and exposure identity. It refuses a
stale or changed question, a human answer or replacement, a closed request/topic, a question
correctly expired by that dispatch, or a request-only/thread-level/legacy question with no proven
dispatch. See the [native Inbox contract](../contracts/native-inbox.md) for the full invariant.

## Inbox instruction ownership and project commands

- Change the Inbox agent's standing behavior by asking the Inbox session itself
  (`sessions ask` at its exact address) to update its own `slack-inbox` instructions.
  Never edit its AGENTS.md from another session. A resumed Claude session keeps the
  system prompt it started with, so an edit made around it never enters its context;
  a change it makes itself does. Other sessions pick up new instructions when they start.
  Source: Tejas, 2026-09-18, after the Inbox never saw the turn-outcome rule.

- **A session can live in a folder inside a project** (Tejas, 2026-10-08: "Why do we have an expertise folder in the root workspace?" [decision: lab-work-lives-inside-agent-ecology]): `--project` on ask and create accepts `<project>/<folder>` or its absolute path (`sessionProject` in session-projects.ts; the folder must exist inside the project), and `sessions move <address> --project …` re-homes an idle session, whose next turn resumes the same conversation in the new folder (each turn reads the folder from the session record). Lab work lives inside agent-ecology, never as top-level projects.
- **The lab runs inside Concierge in its own space** [decision: lab-runs-inside-concierge-in-its-own-space]: a session
  created in agent-ecology (including any folder inside it, such as `agent-ecology/expertise/<name>`), lab-commons or any `expertise-*` folder is lab work (`sessionSpace` in session-roles.ts),
  every session view carries `space`, `GET /sessions?space=` filters, and `GET /lab` lists the lab's sessions and
  every request touching it with how it ended. thnkr.ing keeps lab sessions out of his everyday list, Inbox and
  notifications and shows them in its Lab view. An experiment that changes Concierge itself runs on a separate
  instance. See [the lab space](../plans/2026-10-08-lab-space.md).
