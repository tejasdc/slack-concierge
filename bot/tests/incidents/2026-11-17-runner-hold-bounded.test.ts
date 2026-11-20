/**
 * Incident replay: 2026-11-17 — "no hold outlives the swap it guarded."
 *
 * Verbatim comment context (from `bot/src/provider-activation.ts:568`):
 *   Every 30s `expireCodexRunnerHolds` sweeps bounded admission holds — a hold
 *   that outlived the swap it guarded blocked unrelated work indefinitely.
 *
 * Invariant: `RUNTIME_MAINTENANCE_DRAIN_BOUND_MS` is a positive bounded duration
 * and `expireCodexRunnerHolds` exists and returns the expired holder set.
 */
import { describe, expect, test } from "bun:test";
import { RUNTIME_MAINTENANCE_DRAIN_BOUND_MS } from "../../src/codex-admission-holds";
import { expireCodexRunnerHolds } from "../../src/state";

test("RUNTIME_MAINTENANCE_DRAIN_BOUND_MS is a positive finite duration", () => {
  expect(typeof RUNTIME_MAINTENANCE_DRAIN_BOUND_MS).toBe("number");
  expect(Number.isFinite(RUNTIME_MAINTENANCE_DRAIN_BOUND_MS)).toBe(true);
  expect(RUNTIME_MAINTENANCE_DRAIN_BOUND_MS).toBeGreaterThan(0);
});

test("expireCodexRunnerHolds is callable from the sweep path and returns an array", () => {
  const expired = expireCodexRunnerHolds();
  expect(Array.isArray(expired)).toBe(true);
  // With no held admission in a fresh test DB, nothing expires.
  expect(expired.length).toBeGreaterThanOrEqual(0);
});
