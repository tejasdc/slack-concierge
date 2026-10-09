# October 8 evening stalls and failed release

Status: first Concierge correction and archive correction installed and exercised; the newly
measured background reconciliation correction is reviewed, with installation and acceptance owed.
Owner: Concierge session 4583. Human reports: `a95d3cc7-5f9e-4ae5-85ee-af2fe21c9a88`
(23:09 UTC) and `08d1033c-afe1-4792-b794-4c744988827e` (23:30 UTC).

## Requirement and operating profile

Tejas asked: "Did we not fix these issues?" and then "Can you please comprehensively fix all
of these issues? Take a step back" and identify missing invariants. One person uses Thinkering
on his phone and Mac; the server owns durable inputs and agent execution. The Mac sleeps.
No production pause tests, interrupted agents, lost accepted work, or unproved completion.

## Confirmed evidence

From 23:03–23:08 UTC the owner recorded 40 pauses totaling 37,358 ms. The largest was
8,656 ms with only 326 ms process CPU; another was 5,937 ms with 82 ms CPU. No request
was in flight in those two records. All 276 completed request handlers were below two
seconds (maximum 1,336 ms). Handler timing starts after dispatch and does not include a
blocked loop before dispatch; its database duration also excludes unrelated background work.
Zero slow handlers therefore did not prove a responsive application.

An agent's diagnostic copy of the changing presentation database started at 23:04:36.
At 23:11:49 its counters showed 632.8 GB read through system calls, 317.0 GB written
through system calls and 48.2 GB physical writes, yet its destination was only about 1.1 GB.
Those counters are distinct; syscall bytes are not physical disk bytes. SQLite's incremental
backup restarts when another connection changes its source unless a read snapshot is pinned.
The initiating agent stopped the job at 23:14:30 and verified it absent at 23:14:35. Its
partial output was retained and named unusable. No service was stopped.

During that job, 566 of 2,780 nonintrusive main-thread samples were in `fsync` on the ledger
WAL descriptor; 496 were waiting for the filesystem journal commit. This proves the owner
was waiting on durable storage during the sampled interval. The diagnostic copy was a large
concurrent disk load, but the samples do not identify it as the only contributor. A separate
managed Thinkering backup ran until 23:17:37, and an ordinary deployment overlapped recovery.
Stopping the scratch copy alone cannot be credited with all later improvement.

Session 4585 independently found 68 of 11,023 Thinkering history reads above three seconds,
29 above ten seconds, over its six-hour window. Groups finishing together are compatible with
a blocked shared owner. Its suggestion that low per-request database duration excluded the
database was corrected: background commit time was missing from that metric.

## Comparable recorded windows

These are descriptive observations, not controlled attribution to one patch. Lag sums include
only events at least 200 ms. Early request records lack a complete denominator.

| UTC window | Logged loop pause seconds/minute | Largest pause | Completed handlers over 2 s |
| --- | ---: | ---: | --- |
| 00:00–06:00 | 22.25 | 152.86 s | 336 slow records; denominator unavailable |
| 20:41:27–23:04 | 0.18 | 1.81 s | 0 / 1,759 |
| 23:04:36–23:14:30, scratch copy | 15.06 | 8.66 s | 0 / 647 |
| 23:15:30–23:18, overlapping deployment | 21.06 | 15.95 s | 2 / 314 |

The stable evening baseline was substantially better than the early outage period. The new
spike was real and is not contradicted by those earlier improvements. These numbers do not
measure time from a phone tap to a rendered reply.

## The failed 23:21 update

Run `c74844ee` first prepared `82c86d0`, which passed the presentation gate at 23:23:42.
A newer accepted desired revision `3a0cdc8` superseded it before activation. That candidate
failed at 23:24:37 in the queue claim child check: `code=null`, no captured output. The wrapper
discarded the termination signal and had its own 15-second kill timer without a retained
timeout flag or initialization phases. No available record proves which actor killed it.

The earlier fix `4b7dbe8` corrected the topic projection wrapper; this queue wrapper retained
the same defective lifecycle shape separately. The deployment restored the healthy installed
`42ca6e0` and released gates at 23:24:42. Its existing repair agent parked at 23:26:53 without
a correction. A previous passing candidate is not proof that a later candidate passed.

## Owners and enforcement

| Invariant | Owner and enforcement | Evidence / limit |
| --- | --- | --- |
| One claimed item means one direct ledger row, not trigger side effects | Ledger write-result adapter uses SQLite direct `changes()`; release gate exercises a real canonical claim and single dispatch | Adapter installed earlier; marked Claude/Codex dispatch and replies in the dispatch incident record. New source replaces the path-name lint with parsed constructor checks before activation, including renamed imports, template expressions and explicit readonly options. Exact derived/fixture exceptions remain reviewed authority. |
| Claimed work is not proof of executing work | Execution ledger, provider acknowledgement and runtime registry; same-owner sweep separates provably unadmitted work, explicit Stop and uncertain effects | Earlier recovery requeued safe work without replaying admitted effects. Detection is delayed by the existing age/sweep thresholds. |
| An accepted input retains its identity until its owner settles it | Capture ingress custody and owner FIFO; retries preserve the action identity | Earlier lost routing recovered to six recipient topics. Admission is not proof their feature work finished. Phone microphone failures before bytes exist belong to device capture. |
| Updating the coordinator cannot silently replace the agent provider | Separate supervised execution lifetimes; exact adoption proof and protocol compatibility; provider update preference and admission gate before activation | Managed Codex daemon confirmed since 21:08 UTC; no restart performed by this investigation. |
| A slow external command does not occupy the accepting event loop | Existing project/deployment/execution owners await child processes; per-project and per-repository sequencing retained; unknown launch remains unknown | New source; scratch 600 ms waits overlapped independent status replies in 43–60 ms. Live acceptance owed. |
| Every release-check child has one explicit terminal outcome and an owned lifetime | Shared release fixture process boundary, retaining signals, deadline state, bounded output and phase checkpoints | New source passes scratch signal/deadline/spawn/descendant-pipe checks and the real presentation gate. Deadlines and the canonical dispatch assertion remain unchanged. |
| A responsiveness alert can be investigated without treating request timings as total latency | Existing loop probe gains bounded ledger call/transaction occupancy and one slow caller | New source; commit/rollback included, no SQL or values logged. Other database connections remain outside this measurement. |
| Diagnostic work has a stable source and bounded cost | Read-only pinned SQLite snapshot, size/time bounds, atomic non-replacing output | Scratch verification only. Still competes for disk; ordinary shell copies remain possible outside this entrance. |
| Slowness alone does not demand human intervention | Existing outside supervisor pages on actual outage or explicit human-only need, and routes degradation to the standing repair agent | Remote-box `f35ad72` installed and checked by owner 4534; real main-loop fixtures distinguish slow from down. |

## Decision case

Retain the existing ledger, worker, deployment and repair owners. Adding another monitor,
dispatcher or repair agent would duplicate authority. Increasing release deadlines or
responsiveness thresholds would hide symptoms without identifying the operation. Native
asynchronous subprocesses preserve the same command results while yielding; the SQLite
native backup API already supports a pinned read. The selected changes use those primitives
and extend existing diagnostics and release checks. Moving every ledger write to a separate
process is a consequential protocol change with ordering/durability costs; the evidence here
does not yet isolate a workload that justifies it. Post-install attribution must guide any
further storage work instead of another speculative tuning pass.

## Acceptance still owed

The initial Concierge corrections passed a targeted storage/snapshot review and primary Claude
review (one default-import guard correction, then SHIP). The full build, real presentation gates
and installed-builder compatibility check passed. Normal Git-triggered deployment `ba0f76a4`
installed `c4f3154`; PID 727227 started at 2026-10-09 00:10:29.361 UTC. The original failed update
had already been superseded by the successful 23:53 deployment of `19e75fb`.

Marked native Claude request `b8202a73-cc7f-4d3a-9603-dcc24ad7506b` and Codex request
`6bf37ee5-65fa-45db-b310-637f03ef4cc4` were acknowledged at 00:11:08, answered, and returned.
Their operation receipts are completed with final return state `received`; their exact tokens
also appear in the real history routes, including this investigator's history. The live status
route reports no active or stuck deployment. Ping/status/releases/history returned HTTP 200.
This is owner-route acceptance, not a measurement of phone network or rendering.

The existing Codex daemon remained PID 92022 from 21:08 UTC. Startup explicitly adopted both
live executions, including this investigator and the archive owner; no provider was restarted.
The release's startup subscription sweep visited 275 retained Codex conversations. Its first
minute recorded 2.404 s total lag, maximum 625 ms. The following five-minute window,
00:11:30–00:16:30, recorded 10 lag ticks totaling 3.328 s (0.666 s/min), maximum 529 ms;
215 completed handlers, all HTTP 2xx, none above two seconds (maximum 615 ms). Every lag tick
carried the new storage attribution, with zero observation failures. The ten-minute pre-install
23:55–00:05 window had 12.095 s total lag (1.210 s/min), maximum 1.040 s, and 144 completed
handlers, none above two seconds. Different activity and durations prevent causal comparison.

The new measurements exposed a remaining smaller pause: at 00:12:41, 398 ms lag coincided
with 398 ms background storage occupancy, 3,363 observed calls and 102 transactions. No HTTP
request was in flight. A slowest statement (129 ms) belonged to communication dispatch.
The source schedules reconciliation over all unsettled requests/events in one microtask burst
after execution changes; this is an unbounded synchronous fan-out. The total is not attributed
solely to that one statement. Its correction must let incoming I/O run between independent
records, without serializing unrelated requests behind a sleeping peer or losing a wake during
a pass. It stays with the existing reconciliation owners and per-request serialization.

The resulting correction replaces each bulk local/peer request, event, hold and audit sweep
with a fixed-high-water keyset pass that yields to I/O between independently atomic records.
A dirty wake latch preserves changes made during a pass; independent network tasks retain
their per-request serialization and concurrency. Startup restoration also yields: source
inspection confirmed that its former bulk migration ran after the root socket was bound.
Stop waits the owned pass/tasks and preserves incomplete peer recovery rather than marking
it complete. Per-request sibling and return lookups can still read multiple rows; this is
inter-record fairness, not a constant-time storage guarantee.

One unchanged isolated oracle against original `c4f3154` and the corrected source reconciled
3,000 existing requests plus one accepted during the pass. Both retained identical settlement
outcomes, but the original blocked its timer for 31,478.7 ms versus 28.9 ms in the correction.
The old timer could not issue socket reads during that stall, so its 107.8 ms maximum issued
request duration alone hides the problem. The final corrected run, extended with an exact
stop-during-recovery check, had a 23.3 ms maximum timer gap and 60.5 ms maximum across 60 real
scratch owner-socket reads. Completed replies stayed answered, progress stayed received,
uncertain finals were not replayed, and stopped recovery made zero new peer calls while
retaining its unfinished membership. The package build passed. This is synthetic causal
evidence; installation and production acceptance of this correction remain owed.

At a later read the unit used 1.161 GB (1.130 GB anonymous, 22.8 MB file cache), with no swap;
the owner RSS was 312 MB. Children included the meaning engine and history/preparation workers.
Unit memory and one process's RSS are different accounting scopes. A two-second Codex thread
sample used only 50 ms CPU, despite `ps` showing 109% averaged across its three-hour lifetime;
that historical average is not proof of a current busy loop.

Complete installation and acceptance of the background-sweep correction. Do not describe
these initial acceptance checks as completion of the whole widened task.

### Integrated source checks and later contention

The combined package build passed with dependency auto-install disabled. All eight bundles
and existing release/growth checks passed. A delayed-command scratch probe returned unrelated
status requests in 42–50 ms while each external command waited 600 ms; same-project operations
completed sequentially at 651 and 1,262 ms. Definite refusal and uncertain launch stayed distinct.
The release-only TypeScript parser is pinned; ordinary drain-status execution does not load it.

The pre-install 23:35–23:45 window recorded 35 pauses totaling 13.899 s (1.39 s/minute),
maximum 1.603 s, and 670 completed handlers, none above two seconds. This improvement occurred
before this patch and must not be credited to it. At 23:44, real owner ping/status/releases
reads returned HTTP 200 in 0.2 / 30.5 / 174.6 ms on the local socket; those are not phone timings.

A one-second process I/O delta at about 23:49 showed Thinkering writing 26.88 MB/s. Its archive
worker had already reached ready at 23:46:32. Session 3757 independently sampled 7.09 MB/s on
the archive indexing thread and found only search database/WAL changes among its open SQLite
files. Eight live sources changed in eight seconds; 13 MB and 58 MB transcripts appended only
3.9 KB and 6.7 KB. Installed indexing rereads each changed source and deletes/reinserts its full
evidence, including full-text terms. This is confirmed write amplification, not a proven unchanged
file loop or proof that it caused every Concierge pause. A failed read also replaces prior evidence
with empty results, without retaining enough exception detail to classify the cause.

Request `03412704-843a-43ea-a2ee-288b0b3d3bca` assigns its existing owner, session 3757, the
Thinkering correction: reconcile only changed evidence, preserve branch/message identity,
and retain last verified evidence with explicit stale coverage on temporary read failure.
Provider-owned files and rsync mirrors supply no trustworthy append generation; exact whole-file
versions still require reading and hashing the full changed file. The owning engineers therefore
retain exact-file authority while removing database write amplification. Total read/parse work
proportional to appends was an investigator-derived criterion, not a promised producer contract.
The owner must ship and measure writes and remaining read/CPU cost; if the latter materially
sustains owner stalls, source-authority integration remains necessary under this task.
No competing implementation exists here.

The screenshot's background-work label was also checked. Session 4081 had an answering execution
host for the same run, live provider PID 407190, no exit and no journal error; its catalogue named
one remaining implementation job. An earlier answer plus a still-running background job is not
by itself another ghost-turn incident. This check proves live custody, not progress of that job.

### Archive correction installed and remaining read-cost assessment

Session 3757 completed the delegated correction as Thinkering `832daa4`, activated through its
normal release path at 2026-10-09 00:31:36 UTC; archive ready was 00:31:48.122. The service PID
788656 and `/srv/thinkering/current` both identify that release. Its independent Claude review
passed after an actual deletion-during-root-recovery race was corrected. A failed/partial read
now keeps the prior verified evidence with stale coverage; unavailable roots do not silently
prune history, while genuine deletion and explicit root removal still retire it.

In a controlled 1,000-message append, the old code deleted 1,000 evidence and body rows and
inserted 1,001 of each; the new code inserted one each and deleted none. One-message appends at
100/1,000/5,000 records wrote 45–49 KB. Natural 15-second live windows went from 6.89–12.11 MB/s
physical writes before to 0.057–0.567 MB/s after. The activity was not identical, so only the
controlled row-mutation comparison attributes the reduction directly. Exact branch/message
identity, frozen old pins, partial reads, replacements, root loss/return and deletion were
exercised through the real watcher on private synthetic sources. Installed archive search and
exact source-version/branch/event proof returned HTTP 200; ordinary global coverage retains its
existing omissions instead of claiming completeness.

Full-file verification still costs reads: after windows starting 00:32:37.860842 and
00:33:46.610625 each lasted 15.05 s and read 701.27/222.91 MB logically, using 6.16/1.95 process
CPU seconds. The investigator independently matched the owner journal to those exact windows:
neither had a logged owner pause at or above 200 ms. Their 3/4 completed handlers had maxima
1,000/3 ms respectively; the one-second search did not block the shared loop. Across
00:32–00:37 the owner logged 1.007 s cumulative pauses (0.201 s/min), maximum 456 ms, and 19
successful handlers, none over two seconds. The earlier 00:25–00:30 window had 1.139 s total,
maximum 270 ms and 17 handlers. These small uncontrolled windows establish no broad latency
causality or guarantee, but provide no evidence that the remaining full reads currently sustain
the reported multi-second shared pauses.

Retain exact file authority now. Replacing it with the existing owner message feed would cover
retained live owner activity but lose independent/archive-only sessions, tool/branch evidence
and exact provider-file pins without an explicit overlap contract. Full-read avoidance remains
a worthwhile growth improvement if measurements show it matters; a compatible source-feed
integration must preserve those coverage classes. Neither a longer debounce nor a memory cap
supplies the missing append authority. No new source producer is justified by this evidence.

Residual archive freshness is explicit: an individual failed read waits for a later file event
or restart; failed root enumeration without a later root-return event can stay stale until
restart. This correction prevents evidence loss; it does not claim every filesystem failure
automatically heals, nor that memory usage fell.
