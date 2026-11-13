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

## Acceptance scenario

- **Seed:** A disposable numeric producer and fake monotonic clocks; an isolated TERM-resistant native observer and child.
- **Action:** Collect seven minutes with read overhead, advance observation time without sufficient owner time, overrun the collector deadline and expire an accelerated native timeout.
- **Expected:** One bounded report covers the full requested owner span; missing span/overrun fails closed; native children no longer execute after timeout. Maintenance policy and numeric privacy remain unchanged.
- **Replayable offline:** yes (`bun bot/scripts/protected-durability-fixture.ts`, no live trial or production state).
