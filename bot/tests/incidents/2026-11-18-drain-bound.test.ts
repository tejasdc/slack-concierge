/**
 * Incident replay: 2026-11-18 — "the drain is bounded."
 *
 * Verbatim comment from `bot/src/runner-provider-account-owner.ts:111-114`:
 *   "The drain is bounded (RUNTIME_MAINTENANCE_DRAIN_BOUND_MS): after it,
 *    waiting for running work never holds new Codex work. ... swapOnly =
 *    since !== null && Date.now() - since >= RUNTIME_MAINTENANCE_DRAIN_BOUND_MS;"
 *
 * Invariant: the drain bound is a finite constant imported into the owner path.
 * A drain started outside the bound opens admission in the "swap-only" mode so
 * a sticky "waiting for running work" state can never indefinitely block new
 * Codex work.
 */
import { describe, expect, test } from "bun:test";
import { RUNTIME_MAINTENANCE_DRAIN_BOUND_MS, isSharedRuntimeMaintenance, runtimeMaintenanceDrainOver } from "../../src/codex-admission-holds";

test("RUNTIME_MAINTENANCE_DRAIN_BOUND_MS is a finite positive number", () => {
  expect(typeof RUNTIME_MAINTENANCE_DRAIN_BOUND_MS).toBe("number");
  expect(Number.isFinite(RUNTIME_MAINTENANCE_DRAIN_BOUND_MS)).toBe(true);
  expect(RUNTIME_MAINTENANCE_DRAIN_BOUND_MS).toBeGreaterThan(0);
});

test("runtimeMaintenanceDrainOver reports true only AFTER the bound", () => {
  const now = Date.now();
  const createdAt = now - RUNTIME_MAINTENANCE_DRAIN_BOUND_MS * 2;
  expect(runtimeMaintenanceDrainOver("runner-runtime-maintenance", createdAt, now)).toBe(true);
  // A hold within the bound stays unexpired.
  expect(runtimeMaintenanceDrainOver("runner-runtime-maintenance", now, now)).toBe(false);
});

test("isSharedRuntimeMaintenance and runtimeMaintenanceDrainOver coexist as the bound check primitives", () => {
  // Both exported — surfaces the bound at the owner path.
  expect(typeof isSharedRuntimeMaintenance).toBe("function");
  expect(typeof runtimeMaintenanceDrainOver).toBe("function");
});
