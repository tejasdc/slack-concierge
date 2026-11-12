# Durable watches

**Status: built 2026-10-07**, step 9 of
[agent work and updates without waiting](../plans/2026-10-07-agent-work-and-updates-without-waiting.md)
(§4.4, §7).

## What it is for

An agent says "wake this conversation once, when this file or directory changes, when this command
finishes, or at a deadline" and then ends its turn. No model stays awake while it waits. It is not a
scheduler: "check every N minutes" stays a repeating saved schedule.

```
router-actions.sh sessions watch file <absolute-path> --until <ISO time | 90s | 30m | 2h | 1d> [--renew] [--required-commit <full-sha>] <source-flags> --action-id A
router-actions.sh sessions watch command --cwd <dir> --until <...> <source-flags> --action-id A -- <argv...>
router-actions.sh sessions watch list <source-flags>
router-actions.sh sessions watch cancel <watch-id> <source-flags> --action-id A
```

`--until` is at most 30 days away. Registration is idempotent by (source input, action id); the same
id with a different condition is refused.

For a request awaiting a particular Concierge repair, use the server's
`/var/lib/slack-concierge-deployment/current` link with `--renew --required-commit <full-sha>`.
The owner reads the linked release manifest and Git ancestry, then requires a successful deployment
receipt for that installed commit. A release without the target commit advances the watch baseline
without waking an agent. The duration renews the storage lease silently while the target is absent;
it is not a recurring agent check. An unconfirmed activation keeps its previous baseline and is
checked again. A Git ancestry error also keeps the previous baseline and is retried; only Git's
definite non-ancestor result can advance it. Registration also checks the installed revision, so a target already live can fire
immediately; the caller checks the installed revision again after registering to cover the race with
its partial reply. The exact target commit is part of the watch condition and idempotency identity.
This scoped condition is available only on the server's Concierge link, and the owner checks it
itself whichever runner the registering agent uses (every server agent runs on the AX41 runner); other file watches retain
their normal change and deadline behavior. A request-bound scoped watch ends quietly when every
request naming its series has closed. A scoped watch fires once: when the target is installed the
series ends instead of renewing, because the next check would find the same installed release and
wake the agent again. A target commit the deployment's full clone does not have (an unmerged or
unfetched draft) counts as absent, not as an error. Name the commit that main will contain: this
repository merges pull requests with merge commits, which keep the branch commits; a squash or
rebase merge gives the repair a new commit, and a watch on the old one never fires.

**Which machine.** A watch is on the machine of the agent that registered it. An agent on a runner
(its helper carries `CONCIERGE_RUNNER_NAME`) sends that name; the watch row records it (`runner`),
and every read of the path, the command's start, its state, output, signal, release and pruning go
to that runner over its call channel ([Runners](RUNNERS.md#runner-machine-calls)); the command runs
in an execution host under the runner's state folder, with the runner's ordinary variables and the
owner's state hidden. The owner keeps every decision, record and delivery. A runner that cannot be
reached is not knowing for that poll, exactly like a host that does not answer: a file watch records
the silence as a gap, a command watch expires at its deadline if its state still cannot be read.
Registration on an unreachable runner fails, and the agent tries again. A watch without a runner
(the Mac, agents on the owner's own machine) is local, as before. Processor seconds are reported only
for local commands.

- **Which runner is trusted.** A call with a runner's own token names that runner, which wins over
  the helper's value; a run token or the local socket carries no machine, so the helper's
  `CONCIERGE_RUNNER_NAME` stands. An agent naming another runner can watch there: agents are never
  handcuffed beyond data and privacy [decision: agents-are-never-handcuffed], and the runner still
  answers only for its own watch executions.
- **One unreachable runner costs one check.** Each poll first delivers wakes already settled, then
  asks every runner with open watches one three-second `ping`, together; an unreachable runner's
  watches are skipped for that poll (their silence becomes a gap, a deadline still settles), so local
  watches never wait on it.
- **A slow start is never mistaken for none.** A launch call waits 45 s, longer than the runner's own
  30 s supervisor wait; the runner answers "unknown" for a start still in flight; and a runner watch
  whose start went unanswered and left no trace starts afresh before its deadline instead of failing.
  A command whose output cannot be read this poll fires on the next one, with its output. Known
  narrow window: if the runner process restarts mid-start, or its supervisor creates the unit after
  its own 30 s limit, the restarted watch can run the command twice, and the abandoned record is not
  pruned. A runner that stops answering mid-poll is skipped for the rest of that poll.
- A renewing series keeps its runner. Watched commands on a runner cannot see the owner's state
  folder or ledger (`CONCIERGE_RUNNER_HIDE_PATHS`), like the runner's turns; a command that read them
  belongs on the owner's machine.

`--renew` is for a standing file condition. It requires a duration. When the file changes or the
deadline expires, Concierge records the terminal observation and the next watch in one ledger
transaction, before delivering the wake. The next watch starts from the observed file version and
has a fresh deadline. A series that requests waited on (a partial reply's `--waiting-on-watch`
names one of its watches) lives only while one of those requests is open: when it next fires or
expires after the last of them closed, it ends as cancelled, does not renew and wakes no one, so a
finished request's release watch stops waking its worker at every release (2026-11-04). A series
no request ever named is a standing condition and keeps renewing. A cancelled watch never renews; cancelling an earlier watch in the series
cancels its current successor. One active renewing watch per session and file is enforced by the
ledger. A Claude session and the Codex sessions that continue its work after Claude usage ran out
keep one renewing series per file between them: a renewing registration from any of them takes the
existing series over (the receipt names it in `takenOverFrom`), so wakes reach the session that
last asked, which owns the watch for cancel, listing and request waits, and one change never wakes
two of them. Thus an interrupted agent turn cannot leave a standing condition unwatched, and no model
runs between observations. The deadline still wakes the model for a missed-change check; choose
the longest acceptable fallback interval because every expiry spends one turn. The thread reader
uses six hours. This option does not claim that a change made and undone during an observation gap
was seen.

## Parts

| Part | Where | Owns |
| --- | --- | --- |
| `bot/src/watches.ts` | inside Concierge, both runtime compositions (`startMachineWatchWorker`) | the `watches` table, the poll, settlement, delivery |
| Watch observation thread | inside the same Concierge process, using `watch-observations.db` beside the ledger | the unchanged-poll cursor and recorded gap, without acquiring the ledger's writer lock or waiting on the interactive owner's event loop |
| `sessions watch` route (`SessionCommunicationCoordinator.watch`) | the owner socket only | validating the registering run exactly as other `sessions` commands do; never forwarded to a peer, never on a public route |
| Execution host (command kind) | `concierge-exec-<id>` on Linux, a launchd job on the Mac | running the command and journaling its exit (`x` frame) |

## Writing a condition that can actually pass

The watch reports what its command says; it cannot tell a condition that is false from one that
could never be true. So the condition is the agent's responsibility, and two mistakes are easy.

**A condition asserting something is *gone* needs a string only that thing could produce.** On
2026-10-08 a watch waited for a release that had removed an agent-callable command, with the
success test "the words `reset-credit` are absent from the installed bundle". Those words also
name the module `codex-reset-credit.ts`, which the same change deliberately kept — so the test
could not pass even after a perfect install. It ran its full three hours and reported
`not-installed-yet`, which would have been read as a stuck deployment that was not stuck.

**Pair it with a positive marker.** Something only the *new* code can emit settles it where an
absence cannot: here `weekly-allowance-not-spent`, a reason string the replacement rule
introduced. The install was in fact live, and the positive marker is what proved it.

And when the question is whether a route or command is gone, **call it** — the running service
refusing it is the fact; a string in a bundle is a proxy for it.

## Lifecycle

`accepted → observing → fired | expired | failed | cancelled`; delivery `pending → accepted`.

- The baseline is saved in the registration row before the registration is acknowledged.
- A deadline and a change that race settle as one terminal event in one transaction; the event and
  its words are written before delivery.
- A fired watch returns one service input with the stable id `watch:<watch-id>:<event>` to its
  registering session so the agent can act on the condition. An expired, failed or cancelled watch
  registered from a placed Inbox thread posts one service line in that thread under the same stable
  identity, without a router turn. Other terminal watches still return to their registering session.
  A refused delivery is retried under the `watch-delivery` policy and restarts its budget at the next Concierge start.

## Versions

- File: content hash up to 4 MiB; above that, modification time and size (the registration says
  which; that mode cannot see a rewrite that keeps both). Directory: names, sizes and modification
  times of the direct entries (a small directory names what was added, removed or modified).
  A missing path is a version: deletion is a change, and a path that appears counts too.
- Command: the worker starts the explicit argv in `--cwd` as an execution host (standard input
  closed, environment limited to ordinary user variables). The exit is read from the host's journal,
  so it survives a Concierge restart. A command still running at the deadline is stopped (SIGTERM,
  then SIGKILL after 10 s) and the watch expires. A command watch never makes an update wait: the
  host is not a turn. Release cleanup keeps the host programs and protocols live watches use.
- A command runs at the machine's lowest processor priority (server: nice 19 and `CPUWeight=1`
  against an agent unit's 100; Mac: launchd `ProcessType=Background`), because it only waits and
  should take almost no time from agents or Concierge. Not `CPUWeight=idle`, which would starve the
  host in the same unit while the server is saturated, so its status answers would time out. On
  the server, `sessions watch list` shows a running command's processor seconds and the terminal
  message says how much processor time the command and its host used since registration, read
  from its unit's cgroup. On 2026-11-03 a sign-in watch re-read 17 hours of journal every minute, used
  about two hours of processor at normal priority while the server was saturated, and only a host
  alert found it.

## Gaps (a deliberate simplification)

The design describes a separately supervised worker. This is one polling worker inside Concierge
(every 5 s), crash-only: registrations are durable, and a restart is a recorded gap. After any
silence over 15 s (a Concierge restart, a sleeping Mac) the next poll rechecks every condition
against its baseline and records the pause as a gap; the terminal message lists the gaps and says
that a change made and undone inside one cannot be known. Nothing pretends to have watched throughout.
A started command watch says something different. Its command runs in its own execution host,
which a Concierge restart does not stop, and its exit and output are read from the host afterwards.
So for a command the gaps are listed as times Concierge was not polling. The message says nothing
the command reported was lost, and that any calls the command made to Concierge during a gap
would have failed. The old file-watch wording sent the canvas reviewers (2026-11-05, 22 gaps
from releases) looking for a lost observation that could not have happened.

The poller runs on the owner's event loop, so anything that freezes the owner freezes every
watch with it. On 2026-11-05 from 13:33 to 21:21 UTC the owner froze shortly after each restart
(Codex recovery and a self-referencing input ancestry walk, fixed by then), and the release watch
series recorded gaps running from one restart to the next, 30 to 64 minutes long. Deadlines that
passed during a freeze were settled on the first poll after the restart, while the runner was still
reconnecting, so they read "runner could not be reached". A poll that itself takes longer than
the 15 s gap threshold logs `watch_poll_slow` with its duration, open watch count, runner ping
time and the slowest watch (id, kind, runner, milliseconds), so a gap without a restart or an
owner freeze names what the poll waited on.

Every unchanged poll advances a persistent cursor so a restart can identify the last observation.
The dedicated thread writes this cursor and its gaps to a separate SQLite database beside the
ledger. It never opens the main ledger or takes its writer lock. The owner reads only open watches'
cursors from the separate store once at startup and keeps confirmed cursors in memory while serving;
the thread removes cursor rows older than 31 days at startup, past the maximum watch lifetime.
An interrupted first creation with no cursor table is treated as an empty store and initialized
by the thread. A damaged sidecar cannot hold the accepting owner in a startup crash loop: it logs
the failed read and uses the ledger's earlier cursor, widening possible gaps while preserving the
damaged file for diagnosis. Terminal settlement
copies the confirmed cursor and gaps into the main ledger transaction with the terminal event,
renewal and delivery intent. A failed cursor write leaves the prior cursor in place, so the next
successful poll reports possible missing coverage rather than claiming unrecorded observation.
The thread has no SQLite lock-wait budget in production and reports slow writes. A power loss may
widen the gap if a recent cursor had not reached disk. Restoring a ledger backup without the
separate cursor store likewise widens coverage gaps, never invents observation. The sidecar is
derived watch evidence; registrations and terminal outcomes are authoritative in the ledger.

On 2026-10-31 at 08:16:55 UTC, an unchanged file watch's one-row update occupied the owner loop
for 1,975 ms with 143 ms of process CPU over the lag interval. Similar calls occupied 1,041 and
1,144 ms at 08:22 and 08:24. Two independent history reads ended 118 ms after the first lag;
their measured read-worker SQLite calls were under 0.1 ms. These records confirm the loop was
blocked by a synchronous watch update. They do not show what the update waited on: no lock-holder
or kernel stack was retained for those seconds, and minute-level host I/O cannot distinguish an
SQLite writer from a filesystem wait. At 08:24:47 a 2,608 ms checkpoint ended four milliseconds
after the watch stall; that overlap is evidence of shared disk pressure, not proof of the exact
wait site. The broader history-read p95 has its own investigation.

Checked on a scratch ledger: file change, command exit code with output, expiry, cancel, a simulated
10-minute pause, racing deadline and change, directory entries, deletion, a held session then
delivery, repeated registration. Script: `agent-scripts/watch-step9/check-watches.ts`.
