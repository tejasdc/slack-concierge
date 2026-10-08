# Durable watches

**Status: built 2026-10-07**, step 9 of
[agent work and updates without waiting](../plans/2026-10-07-agent-work-and-updates-without-waiting.md)
(§4.4, §7).

## What it is for

An agent says "wake this conversation once, when this file or directory changes, when this command
finishes, or at a deadline" and then ends its turn. No model stays awake while it waits. It is not a
scheduler: "check every N minutes" stays a repeating saved schedule.

```
router-actions.sh sessions watch file <absolute-path> --until <ISO time | 90s | 30m | 2h | 1d> <source-flags> --action-id A
router-actions.sh sessions watch command --cwd <dir> --until <...> <source-flags> --action-id A -- <argv...>
router-actions.sh sessions watch list <source-flags>
router-actions.sh sessions watch cancel <watch-id> <source-flags> --action-id A
```

`--until` is at most 30 days away. Registration is idempotent by (source input, action id); the same
id with a different condition is refused.

## Parts

| Part | Where | Owns |
| --- | --- | --- |
| `bot/src/watches.ts` | inside Concierge, both runtime compositions (`startMachineWatchWorker`) | the `watches` table, the poll, settlement, delivery |
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
- Delivery is one service input with the stable id `watch:<watch-id>:<event>` to the exact
  registering session, through the owner's ordinary admission, so a paused or archived session holds
  it and no model run is forced. A refused admission is retried under the `watch-delivery` policy
  and restarts its budget at the next Concierge start.

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

## Gaps (a deliberate simplification)

The design describes a separately supervised worker. This is one polling worker inside Concierge
(every 5 s), crash-only: registrations are durable, and a restart is a recorded gap. After any
silence over 15 s (a Concierge restart, a sleeping Mac) the next poll rechecks every condition
against its baseline and records the pause as a gap; the terminal message lists the gaps and says
that a change made and undone inside one cannot be known. Nothing pretends to have watched throughout.

Checked on a scratch ledger: file change, command exit code with output, expiry, cancel, a simulated
10-minute pause, racing deadline and change, directory entries, deletion, a held session then
delivery, repeated registration. Script: `agent-scripts/watch-step9/check-watches.ts`.
