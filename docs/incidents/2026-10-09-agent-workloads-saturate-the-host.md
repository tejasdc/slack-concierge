# October 9, 19:48–19:53 UTC: owner loop blocked while agent workloads saturated the host

Status: cause identified as operational (host saturation by two agent sessions' own workloads);
one amplifying full-table scan corrected in code. No service, unit or agent was stopped.
Supervisor incident `f16bfc4e-3e1e-4e99-b261-dc6fdfb7d061`, capture `0c7cecb144b8b6456971`.

## What the supervisor saw

`owner_loop_blocked`: 20,283 ms of owner loop lag summed over the five-minute window ending
19:53:13 UTC (the rule fires at 15,000 ms summed or one pause of 10,000 ms). The longest single
pause was 2,656 ms; the slowest completed request 1,949 ms. No memory growth, no swap, no host
pressure episode, prepared presentation caught up, speech worker idle. The installed release was
main's head (`be75a37`), so every earlier responsiveness correction was already running.

## Confirmed evidence

Lag by ten-minute bucket today (owner started 16:38 UTC): 1.2 s, 0.8 s, 0, 0.9 s, 0.3 s, 4.0 s
(19:20), 1.0 s, 2.8 s (19:40), 17.7 s (19:50). Of the 32 lag ticks in 19:30–19:53, every one
attributed its wall time to synchronous ledger calls with little process CPU: for example 2,656 ms
lag with 189 ms CPU and 2,775 ms occupied in 748 calls and 26 transactions (slowest, a single
session-event insert, 778 ms); 1,333 ms lag with 195 ms CPU across 4,176 calls; 1,782 ms lag with
78 ms CPU where one read statement took 1,887 ms. Commits that normally take a few milliseconds
were waiting on the disk and the scheduler, not computing.

Two agent execution hosts started one minute before the burst and were still running at the
time of this investigation:

| Unit started (UTC) | Session | Workload | CPU used by 19:57 | Memory |
| --- | --- | --- | ---: | ---: |
| 19:47:23, `3ef9d796cb759446` | 4031 "Handwritten notes from the Daylight into thnkr.ing" | Android emulator (`qemu-system-x86_64-headless -avd tablet`), 165% CPU, 6.3 GB RSS | 1,299 s | 8.7 GB |
| 19:47:53, `0abe2491d13989f8` | 4558 "Notes editor: remove jumping bar, fix [[ links and relationships" | Thinkering's look gate (`scripts/look-gate.mjs`) drawing screens through a pool of six headless WebKit browsers, each 100%+ CPU, respawned every few seconds | 1,028 s | 3.4 GB |

Host at 19:50:05 (sysstat): load 19.5 on 12 CPUs, run queue 21, 1,782 processes; disk queue
depth 14.9 with 18 ms average wait and 6.8 MB/s reads plus 13.8 MB/s writes over the preceding ten
minutes, up from 0.75 depth and 3 ms at 19:30. At 19:57 the CPU pressure gauge read 46% "some"
over ten seconds. Concierge's service and every `concierge-exec-*` unit run at the default
scheduler weight with no CPU or I/O weighting, so the owner competes equally with the workloads it
hosts. A third session, the Inbox router, began a turn at 19:50:26 and streamed output through the
same owner at the same time.

The 19:20 bucket was a separate, smaller episode of history and event-stream reads (1.0–1.7 s)
with no execution start behind it; it is not covered by this record.

## What was a code fault

The status route counted executions still running on a previous release with
`WHERE state IN ('live','exited') AND host_script IS NOT NULL`. SQLite does not recognise that
list as implied by the `executions_open` partial index (`state IN ('intended','live','exited')`),
so every status read scanned the whole table: 812 rows and 21 MB including each row's processor
record. Normally that costs about 10 ms (339 status calls today, median 35 ms); under the
contention above one scan held the owner loop 1,887 ms. A host script is recorded only when an
intended run is launched (`recordExecutionLaunched`), so the index's own predicate returns the
same rows, verified identical on the live ledger. The read now uses that predicate and walks the
index.

## What remains operational, with a proposal

The remaining 18 s were ledger commits (session events for streamed provider messages, delivered
results and an accepted Inbox capture) waiting on a saturated disk and CPU. Nothing in Concierge
limits what an agent may run on this machine, and nothing gives the owner's loop priority over
agent workloads. Options for the owning sessions, not applied here:

- Scheduler weights: a higher `CPUWeight`/`IOWeight` on `concierge-bot.service` (remote-box) or a
  lower one on execution units (`execution-host-client.ts` launch properties). Hypothesis: keeps the
  owner responsive while agents stay unthrottled in aggregate; unmeasured.
- Durability setting: the ledger runs with SQLite's default `synchronous=FULL` in WAL mode, a disk
  sync per commit. `NORMAL` syncs only at checkpoint and is corruption-safe in WAL; it trades the
  last few commits on a power loss for commit latency bounded by memory instead of disk. Unmeasured
  here; a decision about durability, not a bug.
- Emulator and browser-pool workloads could run under their own resource limits in the projects
  that start them; that is those projects' call.

## Not verified

The lag after 19:53 was not measured against the workloads ending, because they were still
running. No controlled comparison of scheduler weights or durability settings was run. The
change here removes one 1.9 s contributor; it does not make the owner immune to host saturation.
