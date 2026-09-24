# Waiting and retrying: one protocol

Status: design, 2026-09-24. Owner: concierge:3635. Implementation by Codex (see the end).

## The problem, in his words and in the record

On the night of September 23, work stopped three ways, and each time the waiting was the fault:

- **Background jobs nobody watched.** concierge:3279 said it had paused for an update. Its three
  background shells were each looping on `until ! pgrep -f "gpt-6-sol"; do sleep …`. A `pgrep -f`
  pattern matches the loop's own command line, so none of them could ever finish. They held that
  run open from about 20:15 to 04:15 UTC, and update 26381bb7 waited behind them for four hours.
  concierge:3633 lost an hour the same way earlier that day. Tejas: "it looks like the agent did
  not really stop … It has a background job going on for like 4 hours … why are they not aware of
  the background jobs holding the thing here? … if there's like a background job … going on for a
  long time, we just inform the agent saying, hey, this job is going on for more than 30 minutes or
  60 minutes. Do you still intend to keep this going?"
- **Retries that never stop.** Nine update runs in eleven minutes chased a commit that no longer
  existed. A bug report was resent 36 times in one minute. Turns kept retrying into a sign-in that
  had expired. Tejas: "Yesterday we had a huge outage because our services kept spamming things.
  And right now we don't have any sort of heuristics to stop the spam for things that we retry."
- **Retries of the unretryable.** A failure that retrying cannot change (a dead sign-in, a missing
  route, a refused request) was treated like a network blip.

## The invariant

**Every wait has an owner, a condition that ends it, and a holder the owner can see.** A wait
whose end nobody can observe is not allowed: the system refuses to start it, bounds it, or ends it
and says so. Every retry follows one policy that decides, from the kind of failure, whether to
wait for time, wait for a signal, or stop.

The queue is the only timer that admits work (AGENTS.md; the saved-work design builds on the same
queue). Every hold below is a queue state named in `dispatch_failure_class`, never a sleep inside a
process. Scheduled and banked work (concierge:3279,
`docs/plans/2026-09-23-saved-work-scheduled-and-banked.md`) keeps its own timing states; this
design shares the vocabulary and adds no second timer.

**One meaning per hold.** A queued turn's hold says why it waits, and only the matching signal may
release it:

| Hold | Waits for | Released by |
| --- | --- | --- |
| `backoff` (today's `retryable`) | a retry time after a transient failure | its time; also, early, a changed account or cleared usage (`releaseScheduledProviderRetries`) |
| `auth_wait` | the account answering after sign-in | sign-in, activation, credential change |
| `usage_wait` | usage room on any account | a usage reading with room |
| `chosen_time` | a time someone chose (a boundary continuation's `waitUntilMs`, a schedule) | that time only |

concierge:3279 found the defect this table closes: `queueTurnContinuation` marked a boundary
continuation waiting until a chosen time as `retryable`, and `releaseScheduledProviderRetries`
releases every future `retryable` turn when an account is switched. A continuation meant for 3am
would have run in the afternoon, with no error and no trace. Account events now release only
`backoff`.

## 1. Background jobs

**Signal.** Claude reports every background shell and subagent it starts (`system/task_started`
with a task id and description) and every one that finishes (`system/task_notification`). The
runner already keeps that set per run (`claude-code.ts`, `backgroundTasks`), and its six-hour
ceiling is the only bound today. Codex has no background jobs outside its turn, so this applies to
Claude runs.

**States of one job**, keyed by run and task id:

| State | Entered when | Ends when |
| --- | --- | --- |
| `running` | Claude reports it started | it finishes, or its run ends |
| `told-30` | it is 30 minutes old | it finishes, or it is 60 minutes old |
| `told-60` | it is 60 minutes old | it finishes, or the run ends |
| `holding-update` | an update is waiting and this run is one of the runs it waits for | the update proceeds |
| `released` | the owner ended an abandoned job's run (below) | — |

**The notice.** At 30 and at 60 minutes the owner steers one service message into that exact
live run. It uses the same pinned admission as the usage briefing (`briefRunningSessions`), with a
stable input id `background-job:<run>:<task>:<30|60>`, so it can never start a turn and is never
sent twice. It names the job (description, age), says whether a Concierge update is waiting for
this run, and asks two things: do you still intend to keep it, and if not, stop it now. No reply is
owed; the answer is the agent keeping or stopping the job. When an update starts waiting, every run
that already has a job over 30 minutes old is told at once, without waiting for the next mark.

**What the owner sees.** The deployment drain already lists the runs it waits for. It also lists,
for each run, its background jobs with their age and whether the agent was told, and so does the
status that drives his update line. So "waiting for sessions" becomes, for example, "waiting for
Scheduled work: a background job 'wait for Codex' running 3 hours".

**An abandoned job does not hold an update for ever.** A run is holding only on background jobs
when it has already produced its result and has no work left but those jobs. If an update is
waiting, such a run has been told at the 60-minute mark, and the agent has done nothing in the 15
minutes since (no new assistant output), the owner ends that run the way the six-hour ceiling does
today. Its jobs end with the Claude process that owns them. Nothing is lost: in the same step the
owner queues a continuation (`queueTurnContinuation` with a boundary reason, "your background job
'…' was ended so an update could install") in that session, so the agent picks up after the update
and re-checks what the job was for. A run that is still actively working (producing output or
using tools) is never ended this way; the update waits, and the owner's display says why.

## 2. Waiting on a process without matching yourself

**Supported wait.** Agents get one command that waits on exact process ids:
`router-actions.sh wait --pid <pid> [--pid <pid> …] [--timeout <duration>]`. It checks each id
directly, never by pattern, returns when all have exited or the timeout passes, and says which. On
Claude, the better answer is usually no waiter at all: start the work itself with
`run_in_background`, and its completion arrives in the same run.

**Refused wait.** The pre-command guard that already refuses rewriting pushed history
(`history-guard.ts`) also refuses a loop that waits on a pattern (`until`/`while` around
`pgrep -f` or `pkill -0 -f`, or around `ps … | grep`). The refusal says why the pattern matches its
own loop and gives the `wait --pid` command. A one-off `pgrep -f` outside a loop stays allowed.

## 3. One retry policy

One module, `bot/src/retry-policy.ts`, used by every retrying site. A site describes its failure;
the policy answers what happens next. The policy is pure, so it can be read and run without a
provider.

**Three kinds of failure:**

| Kind | Examples | What happens |
| --- | --- | --- |
| `transient` | network error, timeout, 5xx, 429 with or without Retry-After, SQLite busy | Retry with exponential backoff and full jitter: delay = random(0, min(cap, base × 2^attempt)). A stated Retry-After or reset time wins over the formula. |
| `needs-signal` | expired sign-in, usage limit without a stated reset, dirty checkout, missing peer | No timed retry. The work waits in a named hold until an explicit signal: sign-in answers, the credential changes, the checkout is clean, the peer answers. The existing `auth_wait` and `usage_wait` are two of these. |
| `refused` | 4xx other than 429 (missing route, bad request, forbidden), an idempotency conflict, a validation error | Never retried. It is recorded as failed, with the reason. |

A site that cannot tell treats the failure as `transient`, and the breaker below stops it.

**The breaker.** Per retry key (a site plus its target: "deploy of commit X", "bug report Y to
the capture route", "Claude on account Z"): after 5 consecutive failures, or 3 of the same
`needs-signal` or `refused` kind, the key trips. A tripped key stops retrying, and Tejas is told
once per trip, through the provider-free notice path (an Inbox message raised to Needs attention),
with what stopped, why, since when, and what signal will restart it. A later explicit signal
closes it: a new push, a successful sign-in, his retry. So does one probe after the cap time, and a
probe that fails trips it again without a second notice.

**Caps by site** (base / cap): provider turns 15 s / 30 min (today's `providerRetryDelayMs` gains
jitter); deployment runs 1 min / 1 h; peer requests 5 s / 10 min; notification and webhook
delivery 5 s / 15 min; client sends from Thinkering (captures, bug reports) 2 s / 10 min,
persisted on the device so a relaunch continues the schedule instead of restarting it.

## 4. Where it applies

Inventory of 2026-09-24 (read-only survey of slack-concierge, thinkering and remote-box by
GPT-6 Luna, checked against the incidents). Each site moves onto the policy as follows.

| Site | Today | Change |
| --- | --- | --- |
| Thinkering web bug reports (`apps/web/src/bug-report.tsx`) and Inbox captures (`send-to-slack.tsx`) | 30 s, 60 s, 120 s, then every 5 min for ever; resent on every app open; no jitter; retries most errors | Policy schedule with jitter, persisted per report so every open tab and relaunch shares one schedule (one sender per report: a lock keyed by the report's id); `refused` stops; the breaker trips after 5 and shows the report as "not sent" with its reason, and sends one notice once the service is reachable again |
| Thinkering provider resource reads (`session-resources.ts`) and federation peer attach (`session-owner-federation.ts`) | exponential, no cap on attempts, no jitter, no classification | jitter; `refused` stops; the breaker shows "unavailable" instead of retrying silently |
| Thinkering client telemetry | 3 attempts then stops | jitter only (already bounded) |
| Concierge provider dispatch (`providerRetryDelayMs`) | 15 s to 30 min exponential, no jitter | jitter; the hold becomes `backoff`; sign-in and usage already wait on signals (0c1dd40, a061743) |
| Concierge deployment runs (`deployment-worker.ts`) | a new run whenever desired state is unmet; nine in eleven minutes on Sept 23 | runs keyed by desired commit: the breaker trips after 3 failed runs of one commit, with one notice; a new push or a cleared blocker (4aafcd4) closes it |
| Concierge durable notice worker (`durable-notice-worker.ts`) | `maximumAttempts` unbounded by default | the policy's default cap and breaker; a parked notice reaches him once |
| Concierge capture delivery (`capture-delivery-worker.ts`) | 1 s to 30 s, no attempt cap | jitter; breaker |
| Concierge Codex observers (`codex-remote-observer.ts`, `codex-session-observer.ts`) | 100 ms to 5 s for ever | jitter and a 1 min cap; breaker logs once and waits for the App Server to answer (`needs-signal`) |
| Concierge peer requests (`session-peers.ts`) | owed work rechecked every 60 s | `needs-signal` on an unreachable peer: wait for the peer's next contact, with a jittered probe at the policy cap |
| Slack rate-limit wrapper (`rate-limit.ts`) | Retry-After with no cap | Retry-After wins; breaker (Slack is retired, so this only bounds what remains) |
| remote-box Monologue poller (`monologue_poller.py` + `monologue-poll.timer`) | every minute for ever | keep the timer; per-capture attempt count and breaker in the poller's own state, one notice |
| systemd units with `Restart=` (concierge-bot, agent-inbox, thinkering, credential portal, observability) | fixed 3–30 s delays, no start limit | `StartLimitIntervalSec=600`, `StartLimitBurst=5` and an `OnFailure=` unit that posts the same one-time Inbox notice |
| Already well behaved: iOS/Mac/Watch outboxes, notification reply, voice transfer, composer uploads, router receipt polling, credential portal | bounded or signal-driven | jitter where a fixed delay remains; nothing else |

The 36 resends in one minute are most likely several open thnkr.ing windows each resending the
same report on open, each on its own schedule. This is inferred from the code, not observed. One
sender per report is the fix either way.

## What he sees

- A job an agent left running is reported to that agent at 30 and 60 minutes. It is not reported
  to him.
- A waiting update names the session and the job holding it. An abandoned job stops holding it
  after the 60-minute notice plus 15 quiet minutes, and the agent continues after the update.
- A retry that trips its breaker reaches him once, as one Inbox item in Needs attention, saying
  what stopped and what will restart it. It never becomes a stream of notices, and never goes
  silent.

## Non-goals

No new service, database or timer. No automatic provider or account switching beyond what exists.
No change to Stop: a person's Stop still ends work without a continuation.

## Delivery

One change across Concierge (policy module, background-job notices and drain display, abandoned-job
release, wait command and guard rule, every Concierge retry site) and Thinkering (its client retry
sites, and the update line naming the holder). Built by Codex in its own worktree, reviewed by
concierge:3635, one push per repository.
