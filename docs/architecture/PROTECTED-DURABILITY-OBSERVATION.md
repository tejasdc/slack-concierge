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
its lock and every existing admission condition. The existing five-minute outer
GNU timeout and two-second kill grace remain. Duration is required, 1..300000 ms;
setup/final output consume that same lifetime, so timeout or missing final output
is incomplete evidence. A request for all 300000 ms necessarily exhausts the outer
lifetime before final output; accepting that argument promises no complete report.
A lone fresh snapshot is available but has no valid observation span.
This command cannot alone cover the worst-case seven-minute
baseline/trial/post-exit envelope. Use a shorter fully covered exposure or obtain
designer review of a separate host observation lifetime. Never silently extend
the deadline or stitch missing intervals into a successful result.

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

Source review and isolated checks do not establish installed observation. Keep
live observation, another cache trial and conversion held for designer and host
coordination. The existing 50% disk veto, PSI, backup services/timers, deadlines,
custody/readback and recovery gates remain authoritative.
