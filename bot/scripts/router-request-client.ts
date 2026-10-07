import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import type { Action } from "./router-post";
import { RETRY_POLICIES, type RetryPolicy } from "../src/retry-policies";
import { nextRetry } from "../src/retry-core";

// Concierge restarts for a few seconds whenever it updates, and an agent's helper call can land
// in that gap. Sending it once and giving up turned a routine update into a failed reply or a
// lost request (design 2026-10-07 §3.1 step 5). The rule that makes a resend harmless:
// - a request that never reached the owner (no socket, nothing listening) can always be sent again;
// - one that may have reached it (connection dropped, no answer) is sent again only when the owner
//   deduplicates it: every session-communication change carries the agent's stable action id, and
//   everything there without one is a read; a GET reads. Project creation and sharing carry no
//   identity, so after a possible delivery they are reported unconfirmed, never resent.
// The same serialized body is resent every time; no attempt mints a new action id.
const ATTEMPT_TIMEOUT_MS = 120_000;
const NEVER_REACHED = new Set(["FailedToOpenSocket", "ECONNREFUSED", "ENOENT", "ConnectionRefused"]);

export type OwnerUnconfirmed = { ok: false; status: 0; result: { ok: false; error: "owner_unconfirmed"; detail: string; attempts: number; retry: { path: string; action_id: string | null; resend_is_safe: boolean } } };

function socketPath() {
  const database = process.env.CONCIERGE_STATE_DB
    || join(process.env.CONCIERGE_STATE_DIR || '/root/.local/state/concierge', 'state.db');
  return join(realpathSync(dirname(database)), 'requests.sock');
}

/** Whether the owner applies this request at most once however often it is sent. */
export function resendIsSafe(path: string, body?: unknown) {
  if (body === undefined) return true;
  return path.startsWith('/session-communication/');
}

function failureKind(error: unknown): "never-reached" | "maybe-reached" {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && NEVER_REACHED.has(code) ? "never-reached" : "maybe-reached";
}

export async function requestApiResponse(path: string, body?: unknown, policy: RetryPolicy = RETRY_POLICIES.ownerRestart) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const safe = resendIsSafe(path, body);
  const started = Date.now();
  for (let attempts = 1; ; attempts++) {
    let failure: unknown;
    try {
      // The socket path is resolved per attempt: a restart may have replaced the directory link.
      const response = await fetch(`http://localhost${path}`, {
        unix: socketPath(), signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        ...(serialized === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: serialized }),
      });
      const result: any = await response.json();
      return { ok: response.ok, status: response.status, result };
    } catch (error) { failure = error; }
    const kind = failureKind(failure);
    const now = Date.now(), elapsed = now - started;
    // Logging is deliberately absent: this runs inside agents' commands, whose stdout is the answer.
    const next = nextRetry({ policy, attempt: attempts, startedAtMs: started, nowMs: now,
      classification: kind === "maybe-reached" && !safe ? "permanent" : "transient" });
    if (next.action === "stop") {
      const actionId = body && typeof body === 'object' && 'action_id' in body && typeof body.action_id === 'string' ? body.action_id : null;
      return { ok: false, status: 0, result: { ok: false, error: "owner_unconfirmed", attempts,
        detail: kind === "never-reached"
          ? `Concierge did not answer for ${Math.round(elapsed / 1000)} s (it may be restarting); nothing was sent.`
          : `The connection to Concierge ended before it answered, so whether it took this request is unknown: ${failure instanceof Error ? failure.message : String(failure)}`,
        retry: { path, action_id: actionId, resend_is_safe: safe } } } satisfies OwnerUnconfirmed;
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, next.atMs - Date.now())));
  }
}

export async function requestApi(path: string, body?: unknown) {
  const response = await requestApiResponse(path, body);
  const result = response.result;
  if (!response.ok) throw new Error(result.detail || result.error || 'Concierge request API rejected the request.');
  return result;
}

export function submitRouterRequest(_action: Action): never {
  throw new Error('Agent Slack publication is retired. Use router-actions.sh sessions with the common native owner.');
}

export async function runRouterWork(args: string[]) {
  if (args[0] === 'recover') throw new Error('Legacy Slack recovery is read-only; inspect work request and reconcile prior effects with the owner.');
  if (args[0] === 'request' && args.length === 2) return requestApi(`/requests/${encodeURIComponent(args[1]!)}`);
  const [channel, ...rest] = args;
  if (!channel) throw new Error('work <channel> --before-ts <source-message-ts> [--root-ts <root> | --session-id <id> | --turn-id <id>]');
  const query = new URLSearchParams({ channel });
  const names: Record<string, string> = { '--before-ts': 'before_ts', '--root-ts': 'root_ts', '--session-id': 'session_id', '--turn-id': 'turn_id' };
  while (rest.length) {
    const flag = rest.shift()!;
    const value = rest.shift();
    if (!names[flag] || !value || query.has(names[flag]!)) throw new Error('Invalid or repeated work lookup option.');
    query.set(names[flag]!, value);
  }
  return requestApi(`/executions?${query}`);
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runRouterWork(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ error: String(error) })); process.exitCode = 1; }
}
