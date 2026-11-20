/**
 * Item 3 (2026-11-20) — event-driven admission replaces the 220-second polling
 * ceiling in `provider-activation.ts`. When a repair hold releases, the
 * activation path wakes immediately via `onAdmissionHoldsChanged`. A
 * 900-second safety ceiling remains in case the event path breaks silently.
 *
 * The listener is a thin fan-out: callers register with `onAdmissionHoldsChanged`
 * and are invoked when `fireAdmissionHoldsChanged` is called (from
 * `codex-admission-holds.ts`'s expiration sweep and from the activation path
 * on `holdCodexAdmission` / `releaseAuthHeldWork`).
 */

import { log } from "./log";

export const EVENT_DRIVEN_ADMISSION_CEILING_MS = 900_000;

type Listener = () => void;
const listeners = new Set<Listener>();

/** Register a callback that fires whenever an admission hold enters or leaves. */
export function onAdmissionHoldsChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Emit the event. Called from the admission-holder write paths. */
export function fireAdmissionHoldsChanged(): void {
  for (const fn of listeners) {
    try { fn(); }
    catch (error) {
      log("warn", "admission_hold_listener_failed", {
        error_name: error instanceof Error ? error.name : "unknown",
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log("info", "codex_admission_holders_changed", { listeners: listeners.size });
}
