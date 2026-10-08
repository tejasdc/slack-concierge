# October 8 evening stalls and failed release

Status: diagnosis and source correction in progress; installation and acceptance remain owed.
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

Complete source integration and independent review, normal Git-triggered deployment, installed
revision proof, real owner route/agent roundtrip, and fresh lag/request measurements. Preserve
the failed update record and verify the update banner clears only after a successful install.
Do not describe scratch fixtures, a pushed commit, or a healthy old release as completion.

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
complete Thinkering correction: work proportional to appends, preserved branch/message identity,
and last verified evidence retained with explicit stale coverage on temporary read failure. The
owner must ship and measure it; no competing implementation exists here. This work remains open
under Tejas's widened task and must not be hidden by completing only the Concierge patch.

The screenshot's background-work label was also checked. Session 4081 had an answering execution
host for the same run, live provider PID 407190, no exit and no journal error; its catalogue named
one remaining implementation job. An earlier answer plus a still-running background job is not
by itself another ghost-turn incident. This check proves live custody, not progress of that job.
