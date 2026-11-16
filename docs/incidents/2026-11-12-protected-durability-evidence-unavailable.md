---
failure: Cache experiments could not observe protected durability obligations or account for their completed and outstanding waits.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Protected cache-trial durability evidence unavailable

Source: request `92ed9a3d-05f1-4bc1-b7b0-ac2e20fca39a`, designer session 8693;
prior synchronized diagnostic request `38013343-c0e3-4f12-8a74-8263b65c69e8`.

## What was seen

The previous disposable trial recorded a device-activity refusal and owned native
cleanup, but its runner could not access private durability counters.

## Cause

Thresholded
journal events could not account for every included operation or preserve the
durations of work completing between polls. Foreground impact remained unknown.

## Fix

The accepting product now accounts for two precisely scoped protected lanes in
bounded memory. The existing sealed cache command provides a numeric-only host
read, explicit epoch/freshness/loss, completed durations and outstanding ages.
No private mount, per-poll durable write, admission rule or latency budget is added.
The source-only acceptance is `bun bot/scripts/protected-durability-fixture.ts`;
the protocol and remaining exposure limits are in
`docs/architecture/PROTECTED-DURABILITY-OBSERVATION.md`.

This fixes the evidence capability, not the historical attribution or production
coexistence question. No new live trial or production conversion is part of it.

## Acceptance scenario

- **Seed:** An isolated owner with two labelled obligations, one already outstanding; a bounded host reader with no live state access.
- **Action:** Hold and release covering syncs, finish operations between reads, overflow detail retention and interrupt/stale/restart the observer.
- **Expected:** Exact lane counts and actual durations survive between polls; unresolved ages remain visible; missing evidence invalidates coverage without delaying release. Compiled read command creates no maintenance state, and private sentinel fields never escape.
- **Replayable offline:** yes (`bun bot/scripts/protected-durability-fixture.ts`, disposable Unix socket and WAL only).
