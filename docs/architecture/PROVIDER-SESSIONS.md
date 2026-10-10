# Provider sessions, comparisons, and forks

This document describes how visible Slack threads bind to providers and how Concierge creates comparison and fork sessions. Executable aliases and state transitions live in source and focused tests.

The [unified session owner](SESSION-OWNER.md) adds authenticated native creation,
exact native fork controls, consultation policy and ChatGPT capability hosting
over these same session and turn owners. Slack channel/root is an optional
binding; removing Slack does not remove a persisted provider session. Native
provider policy preserves explicit ChatGPT intent and visible unavailable/start
failure without substituting a different provider.

## Selection and binding

`bot/src/aliases.ts` is the sole authority for text aliases, channel defaults, dispatch overrides, comparison defaults, models, and matching rules. Ordinary text aliases select a provider on the first top-level message. Unknown or provider-invalid suffixes are complete non-matches and are not partially stripped. The router's explicit selection contract below also applies to resumed work.

### Model and reasoning effort are separate axes

An alias chooses a **model**. Reasoning **effort** is its own axis with its own
default, selected independently. Coupling the two would mean a caller who wants
harder thinking has to accept a different model, and a caller who wants a
specific model has to accept whatever effort that alias happened to carry.

Model aliases:

| Alias | Provider | Model |
| --- | --- | --- |
| `cc`, `cc-fable` | Claude Code | `claude-fable-5-1` |
| `cc-opus` | Claude Code | `claude-opus-5-5` |
| `cc-opus-1m` | Claude Code | `opus[1m]` (Claude Code's latest Opus with extended context) |
| `cc-sonnet`, `cc-medium` | Claude Code | `claude-sonnet-5` |
| `cc-haiku`, `cc-fast` | Claude Code | `claude-haiku-4-5-20251001` |
| `cx`, `cx-sol` | Codex | `gpt-6-sol` |
| `cx-astra` | Codex | `gpt-6-astra` |
| `cx-terra`, `cx-medium` | Codex | `gpt-5.6-terra` |
| `cx-luna`, `cx-fast` | Codex | `gpt-6-luna` |

`cc-fast`, `cc-medium`, `cx-fast`, and `cx-medium` are retained tier spellings
for models that also have a model-name alias. They keep their historical
meaning, and an exact alias match always wins over effort parsing, so `cx-medium`
still names Terra rather than medium effort.

**The 2026-09-23 generation move, and the CLI floors it depends on.** Claude Opus
5.5 replaced Claude Opus 5 in Anthropic's current lineup and is cheaper on every
axis, so `cc-opus` names it; `opus[1m]` follows on its own because Claude Code's
`opus` alias now resolves to `claude-opus-5-5`. GPT-6 Sol and GPT-6 Luna replaced
their 5.6 counterparts at half the price. `cx-terra` stays on GPT-5.6 Terra
because GPT-6 Terra does not exist — OpenAI shipped only Sol and Luna in that
generation.

Each side has a client-version floor, and below it the model is unreachable no
matter what this table says:

| Tool | Floor | What the old version did |
| --- | --- | --- |
| Claude Code | 2.1.280 | 2.1.278 refused `claude-opus-5-5` against its own catalog, and the API refused it too, naming the required version. |
| Codex CLI | 0.156 | 0.153.4 refused every `gpt-6-*` name except Astra. |

Codex's refusal text is worth knowing, because it lies about the cause: "The
'gpt-6-sol' model is not supported when using Codex with a ChatGPT account"
reads as a plan entitlement and is not one. The same account on the Mac's 0.156.0
accepted `gpt-6-sol`, and the box accepted it once upgraded. It is Codex's
generic answer for a name the client cannot negotiate, so check the CLI version
before concluding anything about the subscription. It remains the true answer for
`gpt-6-terra`, which no version accepts.

Concierge's own Codex turns spawn a fresh `codex app-server --stdio` child per
turn, so they pick up a new standalone install immediately and need no daemon
restart. The long-running `--remote-control` daemon keeps serving Codex Remote on
whatever binary it loaded; leave it alone per the
[App Server runbook](../runbooks/CODEX-APP-SERVER.md). That daemon is also why
`~/.codex/config.toml`'s default model is a separate decision from this table: a
config default that the loaded daemon cannot serve breaks Codex Desktop sessions,
which is exactly the 2026-09-07 incident.

Reasoning effort vocabulary, one set of tokens for both providers:

| Level | Meaning |
| --- | --- |
| `low` | Least deliberation. |
| `medium` | The Codex default. |
| `high` | More deliberation. |
| `xhigh` | Spoken and written as `extra-high`, which normalizes to `xhigh`. |
| `max` | Most deliberation. |

These five tokens are exactly what `codex -c model_reasoning_effort=` and
`claude --effort` each accept, so a selected level reaches either CLI unchanged
and there is no per-provider translation table to keep in sync. Codex also
accepts `none` and `minimal`; both are excluded because Claude rejects them and
the vocabulary has to stay portable. `maximum` is accepted as a spelling of
`max`.

Compose the two axes by appending the level to any alias: `@cx-sol-xhigh`,
`@cc-opus-max`, `@cx-extra-high`. The router expresses the same thing as
`--provider cx-sol --effort xhigh`; an explicit `--effort` wins over a suffix.
An unknown suffix is a complete non-match, not a partial one, so `@cx-bogus`
selects nothing rather than silently falling back to `cx`.

Defaults when no level is named: Codex uses `medium`, configured in the alias
table rather than inherited from the host CLI's `model_reasoning_effort`, so
Concierge's default cannot drift with host or repository configuration. Before
this default existed, `cx` named no model at all and every Codex turn silently
took the host value, which was `xhigh`. Claude Code keeps no configured default,
so its own CLI default applies until a level is requested.

A Codex repository-local `.codex/config.toml` overrides the home file for work
in that repository, which is why the default lives here rather than being read
from the executing host.

### The default provider

#### Recovery of accepted Claude work at an allowance wall

The server's canonical session owner also checks existing Claude queues on startup, after
an execution changes, and when fresh allowance readings arrive. When every usable Claude
account is exhausted and the signed-in Codex account has verified room, it transfers
eligible accepted work into a linked, independent Codex session. The Inbox router is
excluded and stays bound to Claude. No provider or account is switched inside a running
conversation.
The owner scans held sessions in bounded pages and yields between pages. An ineligible
session cannot keep later sessions out of recovery indefinitely.

Eligibility is deliberately narrower than a usage hold. The source session must be active
and unsuspended, with no running or unresolved execution, outgoing helper, dependency,
artifact delivery, or earlier open request. All its queued turns must be ordinary,
unscheduled inputs. Each must either be untouched or have a recorded usage refusal that
the executor classified as safe to replay before any acknowledged input, output, tool
effect, or artifact delivery. Ambiguous and partially worked turns stay with Claude and
keep their visible hold. The thirteen externally paused sessions in the October 10
incident were not inferred to be safe from their pause action names.

One owner transaction creates a linked Codex successor and new accepted input identities,
retains the original accepted rows and history, records a unique source-to-successor map,
retargets each still-open request's reply authority, and terminates the superseded source
executions. A lost acceptance response still retries to the original accepted identity;
reconciliation finds the same successor rather than creating a second one. Source queue
claims and transfer serialize on the same ledger writer. Later Claude context assembly
excludes transferred source turns, so they cannot reappear as work to replay after reset.
The successor receives the exact original payload and attachments and an instruction to
read the retained source conversation and completed effects before acting; provider-private
Claude state is not claimed to transfer. Results for agent requests follow their original
request and source return path. The original input receipt and successor lineage show the
move. This is a bounded safe-subset handoff, not automatic replay of uncertain work.

Capture custody remains independent of the router's provider. An accepted capture stays in
the Inbox waiting list while Claude cannot route it. The existing provider hold signal now
says explicitly when Inbox routing is paused, gives the provider's reported reset, and says
whether Codex has verified room for safe queued work. The thnkr.ing notification opens the
Inbox waiting view. It is one hold notice per provider, not a forecast or a replacement
Codex router. This choice avoids changing the router's model while making the backlog and
its reason visible. Agent-written task copies were rejected because they do not transfer
canonical reply authority or prevent duplicate execution; automatic in-place provider
switching was rejected because running sessions retain their provider binding.

#### Budget pauses and the October 10 idle-capacity repair

An account limit is a resource condition, not a session Pause. The owner already retains
queued work under a usage hold, checks each account on fresh readings, and releases the
hold when an account it can launch has room. The action API now refuses the incident's
`budget-pause-*` action identity and an explicit `usage` or `budget` Pause value. This
prevents the known outside steering pattern from turning a temporary allowance decision
into an indefinite human-style Pause. A deliberate Pause still requires Continue.

Withdrawing an agent request now also terminalizes its already queued target turn, not
only an unqueued target input. The communication reconciler applies the same rule to
older withdrawn requests at owner startup. This matters when a paused worker has a
queued target: releasing capacity must not run a request another worker already covered.

The owner has one audited incident repair for twelve of the thirteen conversations
paused on October 10. On a fresh, usable Claude reading it compares each conversation's
latest Pause action, exact expected accepted inputs, current queue, pending request
authority and active attempts. Only on an exact match does one transaction mark the
overnight runs covered by the retained Codex result, clear that particular stale Pause,
record the transition, and wake the ordinary queue. The nightly review's already queued
future firing is preserved; other repeating schedules place their next firing through
their existing rule. A new input, newer Pause, uncertain run, or
still-open request makes that conversation stay stopped. The taste-mining conversation
with an open original request is intentionally outside this repair until that request's
result authority is reconciled. This is an exact historical migration, not a prefix-based
policy for future pauses. It does not spend reset credits or change account bindings.

This choice reuses the existing provider hold and FIFO owner instead of adding a
second scheduler. An unconditional Continue was rejected because several original
runs were completed by Codex while the Claude conversations stayed paused; it could
repeat external effects. The retained Codex duty result is the coverage reference for
the exact incident inputs. Manual pauses and unknown outcomes remain binding.

#### Automatic starts for new work

New unbound coding work defaults to Automatic when an agent names a project without a provider;
callers can also request `--provider auto` explicitly. At creation, the session owner reads
recent allowance data for accounts this machine can actually launch. Claude remains the
ordinary choice while its roomiest usable account is below the existing 90% warning level.
Once Claude reaches that level, the owner starts the new session on whichever provider has
more headroom. An explicitly chosen provider, model or effort is never replaced. An existing
session keeps its provider; this is a creation decision, not a fallback or replay chain.

The owner ignores stale or unreadable allowance as proof of room. If both providers are spent,
it binds the new request to the provider whose spent window refills first, so the existing
provider usage hold retains the input and wakes it at that reset. A Claude account with a
stored login and an observed usage refusal remains eligible as a *wait* target even when
its immediate launch proof fails before that reset. If neither provider has a
usable reading or reset, automatic creation refuses instead of guessing. The 90% provider-free
warning names the risk that both providers may stall when both have reached that level;
one combined provider-free warning also fires when both have already crossed 90% before
the release is installed, and closes at the first allowance reset. A
real usage hold retains its ordinary notification. A ChatGPT Pro consultation remains an
explicit informational request: it has no coding workspace and cannot silently replace a
coding session.

The agent request path and Thinkering's Automatic new-conversation choice enter this same
owner decision. Native provider child processes spawned directly by a provider are outside
the owner, so their model selection follows the provider's own tools; work delegated as a
new Concierge session defaults to Automatic. On the server, an agent whose run predates
an update still uses the current installed request helper for a *new* outbound ask; its
run hooks and recovery helpers remain pinned to their original release.

For an independent helper requested by a Claude session, Automatic also sees the source
session. When a fresh launchable Claude account is under budget pressure (the existing
90% warning or its one-hour usage brief) and the signed-in Codex account has more room,
the owner starts that helper on Codex. The decision is repeated at request creation, so
a previously started Claude run gets the current choice without a router message. A
provider named by the agent remains explicit; the source session and its admitted work
stay on Claude. Provider-native child tools still use their parent's provider.

The existing usage watch tells each running session about its own budget and current
launchable room on both providers. Under Claude pressure, the same room decision adds
an instruction to delegate bounded implementation through a new session request, while
the Claude agent keeps the approach and reviews the result. A change from no Codex
delegation room to verified room creates one new brief in that allowance episode. New
turns receive the same brief in their opening context. These are service notices to
the agent, not human Inbox alerts or a provider switch for an active run.

`DEFAULT_PROVIDER_ALIAS` in `bot/src/aliases.ts` remains the static preference for
legacy callers and project defaults that name no provider. It is `cc-opus` — Claude
Code on `claude-opus-5-5`. New work entering through `auto` uses the owner's live
allowance choice above; `sessions projects` still reports the configured project
default, and explicit selections still use the alias table.

The Codex allowance is [account-scoped](../incidents/2026-09-15-codex-usage-limit-scope.md)
and was exhausted on a second account on September 16, 2026, so starting every
session on Codex was not sustainable. That historical default is superseded for
new unbound native sessions by [Automatic starts](#automatic-starts-for-new-work).
An explicit human provider/model/effort choice wins, and an already-bound session
keeps its binding.

A project or channel that has selected its own provider keeps that selection.
The `channels.provider_default` column is `NOT NULL DEFAULT 'codex'`, so a
project registered before anyone chose a provider carries `codex` without that
being a choice. `codex` is not an alias key and every selection path — Slack's
`/switch-provider` and the native project default control — stores a canonical
alias instead, so `configuredProviderDefault()` reads the bare sentinel as "no
selection" and applies `DEFAULT_PROVIDER_ALIAS`. A real selection is returned
unchanged, including its effort suffix. That is why moving the default needed no
data migration and cannot overwrite a deliberate choice.

### One provider policy

The following precedence records the retired DM router and bound-session behavior.
New unbound native sessions use [Automatic starts](#automatic-starts-for-new-work):

1. The user's explicit provider, model, and reasoning-effort choice, expressed by the router with `--provider` and `--effort`.
2. Otherwise, design, brainstorming, and review requests select `cc`. This overrides a channel default of Codex.
3. Other work omits the flag: an existing bound session retains its explicit provider/model binding; an unpinned Codex session resolves the current `cx` default from this alias table. New native sessions use Automatic; the historical Slack path resolves `DEFAULT_PROVIDER_ALIAS`, which is `cc-opus`.
4. An A/B comparison is intentionally different from ordinary routing: without an explicit target it selects the source session's counterpart (`codex` → `claude-code`, `claude-code` → `codex`). An explicit `!compare @alias` wins for that comparison only.
5. A provider outage never switches anything by itself. A stuck human message is offered the alternatives that answered a live check at that moment, and runs on one only when Tejas picks it (in the notification or on the message); see the `provider_outage` offer in the wire contract. This is a per-message choice, not a fallback chain, and it never changes a session's selected model (Tejas, 2026-09-22).
6. Usage failure changes the executing model within the selected provider's configured chain; it does not change the requested preference. Claude tries the exact IDs in `CLAUDE_USAGE_FALLBACK_CHAIN`, then reports exhaustion visibly. It never silently switches to Codex or silently waits for a quota reset. Retry uses the existing turn controls; a user may explicitly ask the router to select Codex. There is no Codex-to-Codex chain: the [Codex allowance is account-scoped](../incidents/2026-09-15-codex-usage-limit-scope.md), so `cx-sol` is a quality and cost choice, never an availability fallback.
7. Within a selected provider, a running turn may start other agents in two directions: it delegates bounded work down to cheaper models and escalates a stuck problem up to a stronger independent investigator. The global instruction file's Model selection section is the authority for both (see [delegation and escalation](#delegation-and-escalation)); this document owns only the alias table they name. Neither direction changes the turn's own binding, adds a selection mechanism, or overrides an explicit user choice.

The request field wins over aliases inside forwarded task text. The router must resolve explicit user preference before supplying it. Without one, Automatic applies only when a new native session is created; it never mutates running work or an explicit durable binding. Reviewer instruction policy owns reviewer independence and original-transcript/fidelity checks; this runtime policy owns provider intent and failure behavior. The review-policy thread at `1789435604.076219` settled the same-provider case: a Claude implementer still gets a fresh Claude reviewer, with disclosure that this lacks a second provider's perspective. Already-bound sessions do not alternate providers automatically.

Managed reviewer turns use this same adapter and fallback chain. Direct `claude -p` review subprocesses, deployment-repair CLI runs, and externally owned Codex turns bypass it; selecting a reviewer in prose does not give those runners automatic fallback. The [dispatch audit](../incidents/2026-09-15-provider-dispatch-fallback-audit.md) records that boundary. Their owning workflows must report quota failure explicitly and preserve the selected review/comparison counterpart; this router change does not claim to retrofit those runners.

The routed message shows the selected provider/model even when its task is a file. The receipt reports `provider_selection`. The final footer still reports the actual provider-reported model, including fallback. The user corrects classification by asking the DM router to use a specific provider through the same contract.

### Delegation and escalation

A running provider turn decides for itself when to hand work to another model.
The rule lives in one place, the global agent instruction file's **Model
selection** section (`~/.codex/AGENTS.md`, linked from `~/.claude/CLAUDE.md`),
because it governs every project and both providers; project AGENTS.md files
point to it rather than restating it. In short: work whose acceptance criterion is
already fixed goes **down** to a cheaper model and the parent reviews the result;
a problem that is stuck — unknown cause after a failed fix, a regression from the
agent's own fix, the same report again, or Tejas's frustration — goes **up**: stop
shipping guesses, research the platform, and get a second opinion without asking;
the session then codes from its findings itself. The big guns for second opinions,
deep research and building expertise are ChatGPT Pro on Tejas's own subscription,
reached with `sessions ask --provider chatgpt --effort pro` and the evidence attached
as files, because it spends no Claude or Codex allowance (October 9, 2026
[decision: chatgpt-pro-is-the-big-guns]). GPT-6 Sol remains the read-only
investigator when the second opinion must read the repository itself. GPT-6 Astra is
brought in only when the same issue has come back three or more times and ChatGPT Pro
is unavailable or its answer did not hold (Tejas, September 23, 2026, replacing his
September 22 Astra-first rule). Fable 5.1 stands in only when the named model is
unavailable. Outside that repeat threshold, Astra still needs his explicit choice. Tonight's audit that motivated the escalation half is in
[the incident note](../incidents/2026-09-22-no-escalation-audit.md).

Model roles for both directions:

| Alias | Model | Role |
| --- | --- | --- |
| `cc-opus` | `claude-opus-5-5` | Default parent: judgment, design, diagnosis, and review of delegated output. |
| `cc`, `cc-fable` | `claude-fable-5-1` | Escalation investigator only when Astra is unavailable; also design and review. |
| `cx`, `cx-sol` | `gpt-6-sol` | Substantial but well-scoped implementation, at the default `medium` effort. |
| `cx-medium` | `gpt-5.6-terra` | Balanced quality, latency, and cost. |
| `cx-fast` | `gpt-6-luna` | Mechanical edits, reproductions, and checking stated claims. |
| `cx-astra` | `gpt-6-astra` | Read-only escalation oracle for a stuck problem, started without asking; otherwise only by Tejas's explicit choice. |

**How the rule reaches running sessions.** Claude Code rereads the global file
and receives Concierge's per-turn prompt (`SESSION_INPUT_INSTRUCTIONS`, passed as
`--append-system-prompt`) each time a run starts, including a `--resume`; Codex
receives that prompt as per-turn context, while it reads AGENTS.md only when its
thread starts. So the per-turn prompt carries a short summary of both directions
and names the `codex` CLI by full path, which a provider child's PATH lacks. A
message that steers into a Claude run already in progress gets neither, which is
why the Inbox router states the escalation directive in the forwarded request
itself when a trigger applies. `scripts/model-use-audit.py` counts delegation and
escalation per session from the transcript archive.

### Resuming with a selected provider

`post`, `resume`, and `upload` accept `--provider <alias>`; [the router runbook](../runbooks/ROUTER-ACTIONS.md) gives syntax. A selected new request owns an isolated session, including in shared-session channels. A same-provider resume stays in its native session and queues a separate turn with the selected model. It cannot become steering that silently keeps the old model.

A different-provider resume creates a linked Slack root and isolated provider session. This is continuation using recorded conversation text, not a native cross-provider clone. The source keeps its identity and provider; normal replies in the new root stay in the selected session. Follow the returned receipt: its destination may differ from the requested source root.

The existing request record captures the source session, provider identity, and exact older turn IDs at acceptance. Existing dependency edges wait for those source turns to settle, including their acknowledged steering and final answers; later source turns do not extend the wait or enter the snapshot. Completed sources are snapshotted at acceptance. For active sources, the destination queue owner snapshots canonical user inputs and agent answers before its first invocation, retaining the bytes for retries. The current request stays separate from history. No summary model, new worker, queue, or timer is involved. Work is proportional to the selected conversation and dependency edges, runs only at acceptance/activation, and does no idle work.

Known context gaps fail before publication. Gaps discovered after an active source settles park the destination visibly through existing setup-failure projection. Missing canonical input, unacknowledged steering, unreplayable attachments, unrecorded native-fork ancestry, and Codex Remote history cannot be silently omitted. The router must explain the failure and obtain an explicit continuation brief and needed files. Native tool state is not transferred. A safely rejected provider turn can be included as a rejected request without waiting for quota recovery; ambiguous provider outcomes remain blocked. An active source that later parks still blocks its dependent continuation until resolved, following normal dependency semantics. An already-interrupted source rejects before publication; if owner-death recovery interrupts a source after acceptance, that same recovery event visibly fails its waiting continuations. It does not mark interrupted work as a successfully settled dependency.

Stopped source inputs are a continuity gap too: cross-provider transfer requires an explicit brief or a resume in the original session; see [interrupted input continuity](TURN-LIFECYCLE.md#interrupted-input-continuity).

This reconciles the usage-fallback request at `1789434412.498579`, review request at `1789435604.076219`, design-selection brief at `1789436463.575829`, and `#blogs` default at `1789049374.073799`. The [communication research](https://github.com/tejasdc/agent-ecology/blob/bd8361f/docs/research/2026-09-14-codex-clarity.md), from `#agent-ecology` root `1789435748.979459`, aligns with this immediate policy. Its proposed communication-rule test is separate; later evidence may justify narrowing the intent preference through this contract.

Provider sessions are persisted in SQLite and own at most one `running` or
`delivering` turn. Additional accepted inputs for the same `session_id` remain
ownerless durable turns and are promoted in admission order; different sessions
remain independently runnable. Codex controllers and the Remote observer
multiplex through one persistent Concierge client connected to the managed
shared App Server daemon. Its Node bridge performs only the WebSocket-over-Unix
transport that Bun lacks; it initializes once per connection and fans provider
events out inside Concierge. Desktop and mobile Remote clients therefore see
the same live thread and progress events. The clean Slack request is the real
`turn/start` user input and carries a stable `clientUserMessageId`, preserving
Codex's native preview and naming behavior. Dynamic skill, artifact, and
response-fallback instructions travel in that turn's application-scoped
`additionalContext`; they are not written into thread settings and cannot leak
into a later loaded turn. A loaded project `AGENTS.md` suppresses the fallback
only when Concierge can prove that it owns the cumulative `TL;DR:` response
contract; otherwise every turn carries the fallback. Generated managed-project
`AGENTS.md` is the durable owner. Claude Code uses stream JSON with replayed user
messages, passes turn instructions through `--append-system-prompt`, and keeps
stdin open while steering remains possible.

Claude's background shells and background agents live inside its CLI process, and
Claude delivers their completion only while stdin is open: once input closes, its
print-mode wind-down kills background shells after five seconds and background agents
at a ten-minute ceiling. Until 2026-09-18 Concierge closed stdin at the first result
and killed the CLI two seconds later, so every "I'll wait for this in the background"
silently died and nothing resumed the session (concierge:3377's Astra run, TestFlight
uploads on the Mac). The runner now counts the CLI's `system` `task_started` /
`task_notification` events. A result with background tasks still outstanding keeps the
run live: stdin stays open, a keep-alive holds the inactivity boundary off, and
Claude's own queue runs the completion turn (its user row carries
`origin.kind: "task-notification"` and is published as this run's continuation). The
last result with nothing outstanding closes the run, and if no turn follows the final
completion within a minute the run closes anyway. The wait is bounded by
`CONCIERGE_CLAUDE_BACKGROUND_WAIT_CEILING_MS` (six hours by default), after which the
run closes and Claude's wind-down stops the remaining work. Human messages during
the wait join Claude's queue as usual and Stop ends everything. Because the run is
live, a waiting release waits for it too (Tejas accepted this on 2026-09-18);
the wait is shown to him rather than hidden. Timers such as ScheduleWakeup and cron
report no task and do not keep a run open.

Agents never build waiters (2026-10-07). Finished background work reports back to the agent
that started it, nested helpers included (a nested `task_started` carries
`owned_by_subagent`, and its completion restarts the helper), and Anthropic's sub-agents
documentation says not to write polling or sleep loops. A pre-command refusal of wait-only jobs
existed briefly on 2026-10-07 and was removed the same day: guessing from command text refused real
work. Concierge does not rely
on the notification alone: when Claude marks a job ended (a terminal `task_updated`, or the
job leaving `background_tasks_changed`) and its report has not reached the agent two minutes
later, the owner steers a service notice into the run and stops holding the job
(`noticeMissingBackgroundReport`). The 15- and 60-minute prompts remain the check on jobs
that are still running.

Once App Server accepts a turn, transport failure is not a terminal provider outcome. The controller reconnects, resumes the exact provider thread, and identifies the daemon-owned turn by provider turn ID or the stable user-message client ID. Supported `thread/read(includeTurns=true)` history replays completed items idempotently and proves whether the turn is still in progress or terminal. An explicit reconciliation RPC error, including an unsupported history method, or a failed consultation-policy check parks the same turn as ambiguous. The saved failure includes the initiating error and failed reconciliation with their RPC method, message, and numeric code when supplied; start RPC failures are also logged with exact thread/client-input identity. Repeating an unsupported operation cannot establish the missing proof. The existing parked-turn FIFO fence blocks successors and replay without another owner or daemon change.

Codex cancellation is registered before provider submission. A Stop before submission prevents model input; after submission, a missing provider turn ID or unconfirmed interrupt response remains an uncertain outcome, not a successful cancellation. Stop interrupts an exact known turn without waiting behind an in-flight recovery read. A confirmed terminal provider event still owns cancellation completion; an interrupt acknowledgement alone does not. Late recovery responses cannot attach provider identity, input acknowledgement, or results after the local controller has settled. Consultation restrictions and request/inactivity timeout budgets are unchanged.

Codex consultation defines its deny-all filesystem/network profile and disabled tool configuration in the `thread/start` or `thread/resume` request. Each response must confirm that exact profile, approval policy and sandbox before input or recovered results are accepted. `turn/start` inherits that verified thread policy and keeps `environments: []`; it does not reselect the request-local profile by name. In the pinned [Codex 0.153.4 implementation](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/turn_processor.rs#L808), an explicit turn-level `permissions` selection reloads host configuration with no request overrides, so it cannot resolve the inline table. Omitting that override preserves the active thread profile. Initial input, same-session follow-up and recovery keep the same enforced restrictions without adding a host profile or changing the daemon.

An uninitialized `single-persistent` channel uses one deterministic hidden
session key independent of the triggering visible thread. Concurrent first
messages share that session: the first owns provider execution, later messages
queue durably with their own visible reply threads, and the first provider UUID
is bound with compare-and-set semantics before a successor reloads it. Channel
shared mode also governs future ordinary replies in pre-existing visible roots;
an ordinary historical session row does not override that mode. Historical
turn/session IDs, provider UUIDs, and exact message lookup remain unchanged.
Only explicit fork lineage or a fork/comparison request for that visible root
keeps it isolated. This provenance survives provider rebinding; merely finding
a visible-thread row is not evidence of isolation. Recovered queued input keeps
its accepted session ID, and recognizes shared mode by the hidden key or bound
default UUID, not by inequality with the reply root. Change a channel's mode
only after its accepted inputs and steering have drained; never reparent queued
or historical turns. Comparisons force a fresh session and remain outside
the contention queue. Archiving a session terminalizes its
already-accepted queued turns atomically, without creating a restart-visible
live owner, entering the provider, or reopening the archived session.

Provider rejection does not erase an accepted input. Concierge classifies a
confirmed terminal failure only before tool or artifact activity: 429/5xx,
rate-limit, overloaded, and temporary failures retry the same durable turn with
bounded exponential backoff; authentication, entitlement, subscription,
API-key, billing, and other definite failures park it with a visible resumable
turn ID. Unknown setup failures park rather than guess that replay is safe.
Queued retries and parked turns retain their place in the session FIFO, survive
restart and deployment drain, and use a new fenced attempt identity on resume.
An operator resumes an exact parked turn with
`bun run bot/scripts/session-turn-queue.ts resume --turn-id <id>`.
Post-admission outcomes without confirmed terminality, compatible provider
identity, or complete steering history are parked as ambiguous and preserved,
but that command refuses to replay them. Resume also proves the persisted
artifact reservation is absent or empty before changing queue state.

## Codex Remote control surface

Slack remains the session-origin surface. A logical observer shares Concierge's App Server transport and never starts a Codex thread or creates a top-level Slack message. At process start and after a real connection loss, it enumerates active per-thread provider UUIDs with exactly one Slack-session mapping and calls `thread/resume(excludeTurns: true)` once for each. Resume subscribes that connection to subsequent provider events without loading transcript history. A stale provider thread is isolated so healthy subscriptions continue. The observer never sends `thread/unsubscribe`, because that would also blind controllers sharing the connection. A newly Slack-created session needs no mapping poll: turn execution emits an in-process session-bound event after the UUID is durable, and the observer resumes that exact thread on the shared connection. Single-persistent channels have no unique visible-thread destination and are not mirrorable. Archived sessions are ineligible, although the repository does not currently expose a general operator archival flow. Both the historical inbox and Concierge DM are excluded by stable conversation ID in the default policy and managed unit; the historical inbox name remains excluded for compatibility. `CONCIERGE_CODEX_REMOTE_INCLUDE_CHANNELS` / `CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS` accept comma-separated channel names or IDs.

The observer consumes pushed `item/completed` notifications directly. It does not establish a history baseline, call `thread/read`, rescan mapped threads, or run an idle repair timer. Relevant notifications are serialized in arrival order. A transient SQLite failure retries that same in-memory notification with capped backoff, holding its later final behind it rather than rereading unrelated transcripts. Provider-thread-keyed indexed queries resolve eligibility; the startup fleet query is never used on the event or delivery path. Slack-originated initial and steering inputs share the `slack-concierge:` client-message prefix and are ignored.

The first external user item durably binds its provider turn to the exact authorizing session and Slack destination. Every later external item in that turn must match the same binding. Mapping drift, archive, deletion, ambiguity, or channel-policy exclusion suppresses or parks later work instead of rerouting part of one turn to another Slack thread. Text is preserved; image and audio inputs get explicit typed placeholders; skills and mentions retain their names; and an unknown future content kind gets a fail-closed placeholder rather than disappearing. The pushed provider item ID and a monotonic observation sequence provide idempotency and keep each request ahead of its response. Claim and immediate pre-post delivery both revalidate the binding. Once Slack acknowledges a post, local delivery-state reconciliation retries without reposting; a restart recovers the `sending` claim and reuses the deterministic Slack client ID.

Delivery is wake-driven: startup recovery and a newly persisted event wake the durable queue, while a real Slack retry owns one timer for its due time. With no event or retry pending, the observer performs zero delivery claims and zero recurring work. The mirror table retains one delivery/idempotency row per mirrored external item, and the turn table retains one binding row per external turn; it does not copy every App Server transcript item. The retired history-baseline subscription and observed-item tables remain untouched for safe schema compatibility but receive no new writes. A final agent message is mirrored only for a turn that began outside Concierge. The ordinary Slack turn lifecycle remains the sole owner of Slack-started results. Unmapped or ambiguously mapped provider sessions remain Codex-only.

Startup upgrades the pre-sequence mirror table transactionally when encountered: it copies every legacy row in SQLite `rowid` observation order, verifies row counts and foreign keys, then atomically replaces the old table. Unexpected legacy shapes fail closed without replacing either table.

Remote finals are visible thread replies but never advance the canonical cumulative summary: an app-originated turn does not inherit Concierge's application-scoped cumulative context, so its answer cannot prove that it summarizes the full Slack thread. Comparison and fork follow provider-thread identity across session rebinding and reject any Codex provider history containing external Remote input instead of replaying incomplete history.

Authority: `bot/src/codex-remote-observer.ts`, replay rejection in `bot/src/provider-replay.ts`, Remote tables and mapping queries in `bot/src/state.ts`, and `bot/tests/codex-remote-observer.test.ts`.

## Agent comparisons

`Compare w another agent` is the message-menu A/B surface. It immediately selects the counterpart from the source session through the shared provider-selection policy: Codex compares with Claude Code and Claude Code compares with Codex. There is no confirmation modal. A settled reply thread also accepts `!compare`; `!compare @cc-fast` (or another provider alias) keeps the explicit target override for exceptional comparisons. During a live turn, the same text remains ordinary steering rather than racing a second session. A comparison always starts a fresh provider session in a new top-level Slack thread, including in `single-persistent` channels.

Concierge resolves the selected Slack message to its exact owning turn, including the user's message, the agent's progress projection, replaced progress replies, final delivery chunks, and the cumulative-summary cursor. An action on any of those messages replays history through that exact turn. The thread-composer command intentionally selects the whole latest settled session because the command itself is not part of provider history. The comparison input is persisted canonical user history through that boundary:

- Earlier entries are context and the last is the active request.
- Agent responses are excluded.
- Hydrated Slack links and completed audio transcripts are retained.
- A turn is replayable only after canonical input is stored and provider start is proven; raw Slack text is never a fallback.
- Original non-audio file metadata remains in the durable Slack input claim. Comparison validates that it exactly accounts for the canonical attachment count, then re-downloads those same Slack files through the ordinary provider-input path. Deleted files, missing URLs, malformed legacy metadata, or count mismatches fail visibly with the attachment identity or exact source prompt timestamp; Concierge never silently omits a file. Audio remains represented by its canonical transcript and is not re-transcribed for comparison.
- In-flight, preprocessing-failed, provider-unstarted, acknowledgement-ambiguous, and pre-canonical history is rejected.

The new comparison thread's root identifies the source and target providers, displays the selected original Slack prompt or transcript in plain-text blocks, and lists every original attachment being re-supplied. Earlier user prompts and their attachments remain available to the comparison agent as context but are not otherwise repeated into the visible anchor.

The prebuilt wrapper bypasses ordinary mention stripping, skill selection, inline capture, and link hydration. It is sent over stdin to avoid host argument limits. Comparison agents retain normal tool permissions and can modify the project. Starting fresh, rather than resuming or forking, prevents the original provider's hidden state from contaminating the comparison.

The message shortcut uses its Slack trigger identity and `!compare` uses the exact command timestamp as stable request identity. Each path durably claims that request before it creates the thread. Turn admission atomically attaches the request to the accepted turn, retries reuse the claim, and startup reconciles interrupted nonterminal requests against their provider turns. Provider retry and parked outcomes keep the comparison request nonterminal; durable response delivery marks it `done` in the same terminal transaction. The visible comparison root is the only success confirmation. Every preflight, attachment, or provider failure posts one idempotent visible reply inside the source thread and is logged. When the comparison root already exists, its ordinary durable terminal projection also preserves the full failure detail and Retry state.

Authority: `bot/src/comparison.ts`, comparison transitions in `bot/src/state.ts`, shortcut handling in `bot/src/index.ts`, and `bot/tests/comparison.test.ts`.

## Provider-session forks

Slack slash commands are unavailable in a thread reply composer, so `/fork` is the channel-composer convenience, an argument-free `!fork` reply invokes that same whole-session flow for its source thread, and `Fork from here` is the point-in-time message shortcut. `!fork` is consumed as an action only after live-turn steering has had first claim; top-level messages and forms with arguments remain ordinary input. A successful fork posts a new top-level Slack anchor; replies continue the child provider session. For a point-in-time fork, that anchor links to the exact source Slack message and quotes a bounded plain-text preview captured with the durable request, so retries and recovery retain the same human-readable breadcrumb. A reply inside the source thread cannot be a fork anchor because Slack has no nested threads.

For Codex, each Concierge turn persists its App Server turn ID. A point-in-time fork passes the exact selected ID as inclusive `lastTurnId` to one-shot `thread/fork`. It never invokes the interactive `codex fork` TUI or a nonexistent `codex exec fork` command. Every explicit boundary must be proven. If later steering was accepted into the same Codex turn, the original request is no longer an exact boundary; the completed agent response is. Legacy backfill succeeds only when canonical replay text uniquely identifies one Codex turn. Forks set `deferGoalContinuation=true` so a cloned active goal cannot run before the user asks something in the child thread.

Claude Code exposes whole-session forking but no proven point-in-time boundary. Its message shortcut is rejected; bare `/fork` remains available for the latest complete session.

Fork creation follows the durable lifecycle:

```text
claimed -> forking -> forked -> delivering -> binding -> delivered
```

The request stores a unique recovery marker and deterministic Slack message ID before provider work, then records the child provider UUID before Slack delivery. `binding` persists Slack's top-level timestamp before session creation so a known anchor is never reposted. Transient Slack failures retry the same ID; permanent failures park without discarding the child.

Recovery first proves the previous process owner dead. Interrupted Codex recovery requires both the exact `forkedFromId` and recovery marker from App Server thread enumeration. `parentThreadId` identifies sub-agents and is not a fork-recovery key. Zero matches may retry only from a dead owner; multiple matches remain ambiguous. Claude interruptions remain ambiguous because its CLI has no equivalent marker. Only invalid-parameter JSON-RPC errors are definite rejection; internal errors enter ambiguous recovery.

Authority: `bot/src/fork-requests.ts`, fork transitions in `bot/src/state.ts`, `bot/src/codex.ts`, `bot/tests/fork-requests.test.ts`, and focused fork cases in provider/state tests.
