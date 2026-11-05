import { dirname, join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import type { Action } from "./router-post";
import { RETRY_POLICIES, type RetryPolicy } from "../src/retry-policies";
import { nextRetry } from "../src/retry-core";
import {OWNER_COMMAND_RESPONSE_MS} from '../src/owner-transport-policy';

// Concierge restarts for a few seconds whenever it updates, and an agent's helper call can land
// in that gap. Sending it once and giving up turned a routine update into a failed reply or a
// lost request (design 2026-10-07 §3.1 step 5). The rule that makes a resend harmless:
// - a request that never reached the owner (no socket, nothing listening) can always be sent again;
// - one that may have reached it (connection dropped, no answer) is sent again only when the owner
//   deduplicates it: every session-communication change carries the agent's stable action id, and
//   everything there without one is a read; a GET reads. Project creation and sharing carry no
//   identity, so after a possible delivery they are reported unconfirmed, never resent.
// The same serialized body is resent every time; no attempt mints a new action id.
const NEVER_REACHED = new Set(["FailedToOpenSocket", "ECONNREFUSED", "ENOENT", "ConnectionRefused"]);

export type OwnerUnconfirmed = { ok: false; status: 0; result: { ok: false; error: "owner_unconfirmed"; detail: string; attempts: number; retry: { path: string; action_id: string | null; resend_is_safe: boolean } } };

function stateDirectory() {
  const database = process.env.CONCIERGE_STATE_DB
    || join(process.env.CONCIERGE_STATE_DIR || '/root/.local/state/concierge', 'state.db');
  return dirname(database);
}

function socketPath() {
  return join(realpathSync(stateDirectory()), 'requests.sock');
}

/**
 * Where the owner is. A run started by an owner on another machine names its network entrance
 * (`CONCIERGE_OWNER_URL`) and carries its own signed token (`CONCIERGE_AGENT_TOKEN`); every
 * other caller reaches the owner's socket on this machine, as before (docs/architecture/RUNNERS.md).
 */
function networkOwner() {
  const url = process.env.CONCIERGE_OWNER_URL?.trim();
  if (!url) return null;
  const token = process.env.CONCIERGE_AGENT_TOKEN?.trim() || runnerToken();
  return token ? { url: url.replace(/\/+$/, ''), token } : null;
}
/**
 * A Codex shell on a runner carries no per-run token (a thread would keep it for its life); it
 * inherits the runner's own address and token file from the App Server the runner started.
 */
function runnerToken(): string | null {
  const file = process.env.CONCIERGE_RUNNER_TOKEN_FILE?.trim();
  if (!file) return null;
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}
function ownerUrl(path: string) { const remote = networkOwner(); return remote ? `${remote.url}${path}` : `http://localhost${path}`; }
function ownerTransport(): { unix?: string } { return networkOwner() ? {} : { unix: socketPath() }; }
function ownerHeaders(): Record<string, string> { const remote = networkOwner(); return remote ? { Authorization: `Bearer ${remote.token}` } : {}; }

/** The private code entrance hides Concierge on purpose, so its scratch state has no owner to wait
 * for. Retrying there looked like a 75-second restart and hid the cause (2026-11-04). A check that
 * starts its own owner under another state directory still waits for it normally. */
function insidePrivateCodeEntrance() {
  const scratch = process.env.CONCIERGE_PRIVATE_CODE_STATE;
  if (!scratch) return false;
  try { return realpathSync(stateDirectory()) === realpathSync(scratch); } catch { return false; }
}

/** Whether the owner applies this request at most once however often it is sent. */
export function resendIsSafe(path: string, body?: unknown) {
  if (body === undefined) return true;
  if(path==='/sessions/v1/canvas-projects/ensure'&&body&&typeof body==='object'&&'clientActionId' in body)return true;
  if(path==='/sessions/v1/agent-report'&&body&&typeof body==='object'&&typeof (body as {actionId?:unknown}).actionId==='string')return true;
  return path.startsWith('/session-communication/') || path.startsWith('/external/');
}

function failureKind(error: unknown): "never-reached" | "maybe-reached" {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && NEVER_REACHED.has(code) ? "never-reached" : "maybe-reached";
}

export async function requestApiResponse(path: string, body?: unknown, policy: RetryPolicy = RETRY_POLICIES.ownerRestart) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const safe = resendIsSafe(path, body);
  if (insidePrivateCodeEntrance()) return { ok: false, status: 0, result: { ok: false, error: "owner_hidden_by_private_code",
    detail: "This command runs inside Concierge's private code entrance, which hides Concierge on purpose; nothing was sent. "
      + "Run Concierge commands and fresh Claude Code launches, such as a reviewer, from the ordinary shell instead." } } as const;
  const started = Date.now();
  for (let attempts = 1; ; attempts++) {
    let failure: unknown;
    try {
      // The socket path is resolved per attempt: a restart may have replaced the directory link.
      const response = await fetch(ownerUrl(path), {
        ...ownerTransport(), signal: AbortSignal.timeout(OWNER_COMMAND_RESPONSE_MS),
        headers: { ...ownerHeaders(), ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(serialized === undefined ? {} : { method: 'POST', body: serialized }),
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
