---
failure: The protected durability observer could not cover the nominal seven-minute cache experiment within its five-minute command lifetime.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Durability observation shorter than the exposure

Source: designer session 8693, request `306a2ef9-f7ff-44d6-ac68-0151e2ffed01`.

## What was seen

The source measurement command inherited the five-minute maintenance deadline.
Its maximum accepted observation duration consumed that same lifetime, leaving
no startup or final-output headroom. A nominal one-minute baseline, five-minute
guarded trial and one-minute post-exit interval could not fit in one report.

## Cause

Observation borrowed a maintenance lifetime despite doing only bounded private
memory reads. The collector also required advancing sample time, rather than
the requested minimum interval between actual owner samples.

## Fix

A single product-owned observation policy allows seven and a half minutes of
actual sample coverage, an eight-minute collection bound and an eight-and-a-half
minute native command bound. The extra half-minute of samples permits alignment
around the nominal seven-minute exposure. Startup and final output fit outside sample coverage. Maintenance
keeps its five-minute deadline, resource policy and admission vetoes. Incomplete
sample spans and collection overruns invalidate evidence. Native timeout retains
the existing kill grace and terminates the owned observer process group.

## Native acceptance regression

Exact-head GitHub runs43362747347 and43362752402 cancelled at15min in the new
TERM-resistant process-group fixture on Ubuntu26.04.1. The case awaited pipe EOF
without independent expiry or cleanup, before checking the returned status.

An independent disposable probe confirmed that upstream uutils timeout0.10.0
kills the immediate child but leaves its grandchild running with inherited pipes
open: attempting to ignore SIGKILL returns EINVAL and prevents the group KILL.
GNU timeout9.4 stops both. Syscall trace, binary digest and exact PID/group custody
are retained in ignored review artifacts. Ubuntu documents Rust tools as the
new image default, strongly supporting CI attribution; the failed jobs did not
print their selected timeout binary, so its exact package identity is unknown.

The fixture now has an independent mock expiry, bounded exit/stream waits and
cleanup using only its recorded PID/start-time identities. It requires actual
SIGKILL escalation and nonexecuting children, preserving the original invariant.
Fallback-expiry markers must remain absent, preventing a missed descendant's
later self-expiry from masquerading as successful native termination.
CI explicitly version-validates/selects GNU timeout in a job-local PATH, using
Ubuntu's supported prefixed command. This retains current-image coverage and
the production GNU dependency without changing production or the machine's
default utilities. Increasing deadlines, accepting exit137 alone, and silently
skipping the case would all retain or hide the failed invariant.

## Acceptance scenario

- **Seed:** A disposable numeric producer and fake monotonic clocks; an isolated TERM-resistant native observer and child.
- **Action:** Collect seven minutes with read overhead, advance observation time without sufficient owner time, overrun the collector deadline and expire an accelerated native timeout.
- **Expected:** One bounded report covers the full requested owner span; missing span/overrun fails closed; native children no longer execute after timeout. Maintenance policy and numeric privacy remain unchanged.
- **Replayable offline:** yes (`bun bot/scripts/protected-durability-fixture.ts`, no live trial or production state).
