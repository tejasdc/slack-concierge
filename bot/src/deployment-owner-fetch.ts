import { join } from "node:path";
import { logToStderr } from "./log";
import { ownerNeverReached } from "./owner-transport-policy";
import { RETRY_POLICIES } from "./retry-policies";
import { RetryBudgetExhaustedError, withRetry } from "./retry-core";

/** Thrown when the owner's socket never accepted the request, so nothing was sent. */
export class OwnerSocketNotReady extends Error {
  readonly ownerTransportUnavailable = true;
  constructor(message: string, readonly cause: unknown) { super(message); }
}

/**
 * The update controller's calls to the serving owner wait for its request socket to accept a
 * connection. Concierge can restart while an update runs (incident dba27ddf, 2026-11-04: a SIGTERM
 * restart at 20:26:02, activation at 20:26:15, the socket serving again at 20:26:18), and one
 * attempt failed the whole update. The readiness signal is the connection itself, retried on the
 * owner-restart policy that agents' helper calls already use, so the wait is bounded and ends the
 * moment the owner listens. Only a request that provably never reached the owner is resent, so a
 * mutation is never applied twice; a read is also resent after a dropped connection.
 * `stopWaiting` lets a caller with an offline fallback give up as soon as the service is fully
 * stopped. Each wait goes to stderr, which stays in the controller's journal; stdout stays the
 * command's machine-readable result.
 */
export async function deploymentOwnerFetch(path: string, init: RequestInit,
  options: { stopWaiting?: () => boolean } = {}): Promise<Response> {
  const stateDir = process.env.CONCIERGE_STATE_DIR;
  if (!stateDir) throw new Error("CONCIERGE_STATE_DIR is required for release state.");
  const startedAtMs = Date.now();
  try {
    return await withRetry({
      operation: "deployment_owner_request", key: path, policy: RETRY_POLICIES.ownerRestart, startedAtMs,
      run: () => fetch(`http://localhost${path}`, { ...init, unix: join(stateDir, "request-owner.sock") } as RequestInit),
      classifyError: (error, attempt) => {
        const neverReached = ownerNeverReached(error);
        if (neverReached ? options.stopWaiting?.() : init.method !== "GET") return "permanent";
        logToStderr("info", "deployment_owner_socket_wait", { path, attempt,
          code: String((error as { code?: unknown })?.code ?? "unknown"), elapsed_ms: Date.now() - startedAtMs });
        return "transient";
      },
    });
  } catch (failure) {
    const error = failure instanceof RetryBudgetExhaustedError ? failure.lastError : failure;
    const attempts = failure instanceof RetryBudgetExhaustedError ? failure.attempts : 1;
    const code = String((error as { code?: unknown })?.code ?? "unknown");
    const message = error instanceof Error ? error.message : String(error);
    if (ownerNeverReached(error)) throw new OwnerSocketNotReady(`The serving owner's request socket did not accept ${path} `
      + `for ${Math.round((Date.now() - startedAtMs) / 1000)} s over ${attempts} attempts (${code}: ${message}); nothing was sent.`, error);
    throw new Error(`The connection to the serving owner ended before it answered ${path} (${code}: ${message}).`, { cause: error });
  }
}
