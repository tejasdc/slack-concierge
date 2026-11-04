# Durable watches

**Status: built 2026-10-07**, step 9 of
[agent work and updates without waiting](../plans/2026-10-07-agent-work-and-updates-without-waiting.md)
(§4.4, §7).

## What it is for

An agent says "wake this conversation once, when this file or directory changes, when this command
finishes, or at a deadline" and then ends its turn. No model stays awake while it waits. It is not a
scheduler: "check every N minutes" stays a repeating saved schedule.

```
router-actions.sh sessions watch file <absolute-path> --until <ISO time | 90s | 30m | 2h | 1d> [--renew] <source-flags> --action-id A
router-actions.sh sessions watch command --cwd <dir> --until <...> <source-flags> --action-id A -- <argv...>
router-actions.sh sessions watch list <source-flags>
router-actions.sh sessions watch cancel <watch-id> <source-flags> --action-id A
```

`--until` is at most 30 days away. Registration is idempotent by (source input, action id); the same
id with a different condition is refused.

`--renew` is for a standing file condition. It requires a duration. When the file changes or the
deadline expires, Concierge records the terminal observation and the next watch in one ledger
transaction, before delivering the wake. The next watch starts from the observed file version and
has a fresh deadline. A cancelled watch never renews; cancelling an earlier watch in the series
cancels its current successor. One active renewing watch per session and file is enforced by the
ledger. Thus an interrupted agent turn cannot leave a standing condition unwatched, and no model
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
- A command runs at the machine's lowest processor priority (server: nice 19 and `CPUWeight=idle`
  on its unit; Mac: launchd `ProcessType=Background`), because it only waits and must never take
  time from agents or Concierge. On the server, `sessions watch list` shows a running command's
  processor seconds and the terminal message says how much processor time it used, read from its
  unit's cgroup. On 2026-11-03 a sign-in watch re-read 17 hours of journal every minute, used
  about two hours of processor at normal priority while the server was saturated, and only a host
  alert found it.

## Gaps (a deliberate simplification)

The design describes a separately supervised worker. This is one polling worker inside Concierge
(every 5 s), crash-only: registrations are durable, and a restart is a recorded gap. After any
silence over 15 s (a Concierge restart, a sleeping Mac) the next poll rechecks every condition
against its baseline and records the pause as a gap; the terminal message lists the gaps and says
that a change made and undone inside one cannot be known. Nothing pretends to have watched throughout.

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
