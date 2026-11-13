# Protected durability observation

Concierge owns these measurements. A host observer reads bounded in-memory facts;
it never opens the ledger or makes foreground work wait for diagnostics. This is
evidence for a future coordinated cache experiment, not a new admission rule,
latency objective or production conversion approval.

## Included boundaries

| Lane | Entry | Successful end | Excluded |
| --- | --- | --- | --- |
| `owner_receipt` | Immediately before the private owner invokes a non-GET handler | The existing barrier resolved and the response continuation is about to return the constructed response | Earlier gateway/network queueing, transmission, caller receipt and downstream effects |
| `provider_input` | The accepting owner's existing labelled pre-dispatch durability call | Its sampled changes are covered and the barrier is about to resolve | Earlier claim/prompt preparation, subsequent provider transport/acceptance, steering and unlabelled barriers |

The receipt timer includes handler persistence, asynchronous handler work and
barrier queueing, including deliberately long handlers; an old obligation is not
automatically evidence of a disk stall. The narrower provider timer includes microtask registration and
durability wait. Neither is full external response latency. A durably released
HTTP error response is not business success. An exception escaping the receipt
wrapper records a failed path and rethrows the same exception; this does not
certify whether that path wrote anything.

The sync algorithm is unchanged: each waiter samples committed `total_changes()`
after the synchronous task; only coverage of its target releases it. A later
target cannot inherit an earlier sync's coverage. Caller disconnect does not
erase an obligation. Sync loss still exits without releasing uncovered work.
Restart creates a new epoch; telemetry never scans or reconstructs the prior
epoch's unresolved work.

## Producer and retention

`GET /supervisor/durability` exists only on the root-private owner socket. It does
not pass the foreground gateway GET allowlist or peer listener. Use the existing
host command; never expose the private mount. Unlike the broader ping, this view
does no ledger query or synchronization.

The fixed schema has numeric values and null unknown ages, without request,
receipt, session or provider identities, paths, dialogue or exception text.
The random numeric epoch identifies a measurement lifetime, not an operation.
Sequence numbers count terminal observations, not business operations.

Per lane: entered/completed/failed/unknown-terminal counts, current outstanding,
oldest age, outcome counts, cumulative duration total and epoch maximum. Counts
reconcile: `initial outstanding + entered = completed + failed + unknown + final outstanding`.
Outcome codes: 0 unknown proof, 1 already covered, 2 confirmed sync, 3 synchronous
commit mode, 4 failed handler path. Already covered does not establish idempotency:
it can be no-write or already-synced work. Confirmed sync proves target coverage,
not that this operation created new writes. Unlabelled barrier calls are counted
separately without claiming their duration or coverage.

Each lane retains at most 2,048 outstanding starts and 256 terminal duration
records. Terminal records contain actual entry/completion monotonic times,
duration and outcome, including work finishing entirely between polls. Overflow
never holds release: counts and epoch maximum survive, with explicit dropped
start/detail counts. An untracked outstanding operation makes the exact oldest
age null; the tracked oldest is a lower bound. The epoch maximum is an upper
bound for a shorter interval, not its exact maximum when detail is missing.
Instrumentation errors invalidate coverage and never reject normal work.

## Existing host command

After a reviewed sealed release is installed:

```
/usr/local/lib/slack-concierge-deployment/control history-cache observe-durability <duration-ms>
```

This uses the existing collected transient host unit, identity, UMask, slice and
priority. A pure read skips the maintenance publication lock so it can observe
maintenance, creating no folder, pin, receipt or ledger. Real maintenance retains
its lock, five-minute lifetime and every existing admission condition. Only this
read-only observation has a separate product-owned lifetime. Duration is required,
1..450000 ms: request 450000 for the nominal seven-minute baseline, guarded
trial/cleanup and post-exit exposure. The additional 30 seconds of sample span
allows phase alignment inside the first and last samples. The collector permits
at most 480000 ms, reserving 30 seconds for read overhead and the final sample;
the outer GNU timeout is 510000 ms, reserving another 30 seconds for native startup and final report
delivery. These are finite observation bounds, not a host allocation or a quiet
lease. The same execution priority and two-second kill grace remain.

Coverage requires at least the requested duration between actual same-epoch
owner samples, as well as reconciled, fresh, loss-free evidence. Initial read time
does not consume the requested owner span. Collection reaching its deadline or
exceeding it is explicitly incomplete, even if a final read eventually returns.
The native timeout terminates the owned process group, escalating to KILL after
the grace period, including when startup or final output stalls. A killed command,
absent/truncated report or nonzero exit never establishes coverage. Kernel-blocked
termination and physical writeback can outlast that grace; this promises no
instantaneous quiescence. Never extend maintenance or stitch separate reports.

Each fixed-path read has a two-second observation timeout and 256 KiB response
cap. Reads are bracketed in observer monotonic/wall clocks. Ages and durations
stay in the owner's monotonic clock; clock epochs are not assumed shared. Epoch
change or nonadvancing sample time is explicit. Owner wall samples outside the
read bracket's two-second tolerance invalidate freshness; this evidence budget
is not a foreground-latency objective. Brackets retain phase-alignment uncertainty.

One final JSON report retains at most 512 frames and 4,096 new terminal details.
Coverage runs only from the first fresh owner snapshot through the last one;
the host read brackets and time outside them are not silently included. Establish
the first snapshot before exposure and retain the final one after post-exit work.
Compare the actual phase boundaries with this single report's sample brackets;
an exposure exceeding its covered span is incomplete, including cleanup that
outlasts the nominal seven minutes. Neither the requested duration nor a valid
report alone proves that the real experiment fit inside it.
Every forwarded field is allowlisted. Reason bits: 1 not installed; 2 restart;
4 stale/nonfresh; 8 instrumentation error; 16 unknown proof/start; 32 completion
gap; 64 observer detail overflow; 128 failed read. Missing, restarted, inconsistent
or dropped required evidence invalidates coverage. A failed read never becomes
healthy zero or reuses a prior frame as fresh. An absent observer has no foreground
consequence. This adds no latency-based stop policy; the existing independent
maintenance stop path remains unchanged.

Zero included operations explicitly means no observed traffic for that lane.
Even complete observations do not establish representative traffic, attribution,
external durable-response latency, tail latency, physical quiescence or acceptable
coexistence. Meaningful overlap with the actual exposed phases and a justified
objective are still necessary before a policy decision.

## Isolated acceptance and live gate

`bun bot/scripts/protected-durability-fixture.ts` exercises preexisting ages,
between-poll durations, failure/overflow accounting, outage/stale/restart states,
private-field removal, the compiled read command without maintenance files, and
real sync workers on a fixture-owned temporary WAL. The receipt-wrapper check
holds durable coverage and proves its response cannot leave early. These checks
never access production or run a cache trial.
Fake monotonic clocks exercise the full seven-minute span plus alignment with read overhead,
insufficient owner span and deadline overrun. An accelerated native timeout uses
the production command shape and unchanged kill grace to stop a TERM-resistant
disposable observer and its child; it does not wait the full native bound or touch live
state. Report frame/detail bounds and maintenance limits remain checked.

Source review and isolated checks do not establish installed observation. Keep
live observation, another cache trial and conversion held for designer and host
coordination. The existing 50% disk veto, PSI, backup services/timers, deadlines,
custody/readback and recovery gates remain authoritative.
