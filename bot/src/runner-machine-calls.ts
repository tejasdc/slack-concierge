/**
 * Calls the owner makes on a runner's machine (docs/architecture/RUNNERS.md "Runner machine
 * calls"): read a path, start or ask after a watched command. Runners open no
 * port, so these ride the relay the runner already keeps open (runner-relay.ts, target
 * `runner-machine`): the owner opens one WebSocket per runner on its local request socket, the
 * gateway pairs it with the runner, and each call is one JSON message `{id, method, params}`
 * answered by `{id, result}` or `{id, error}`.
 *
 * Nothing here is an obligation: the owner's ledger keeps every decision, and a call that cannot be
 * answered (runner away, relay dropped, timeout) is an error the caller treats as not knowing this
 * time, exactly as it treats a local host that does not answer. A call is never resent by this
 * module; the callers' next poll asks again.
 */
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { log } from "./log";

const CALL_TIMEOUT_MS = 15_000;
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Channel = { socket: WebSocket; open: Promise<void>; pending: Map<number, Pending> };
const channels = new Map<string, Channel>();
let nextId = 0;

export class RunnerUnreachableError extends Error {}

function requestSocket() {
  return join(realpathSync(process.env.CONCIERGE_STATE_DIR!), "requests.sock");
}

function channel(runner: string): Channel {
  const existing = channels.get(runner);
  if (existing && existing.socket.readyState <= WebSocket.OPEN) return existing;
  const socket = new WebSocket(`ws+unix://${requestSocket()}:/runner/v1/relay/connect?runner=${encodeURIComponent(runner)}&target=runner-machine`);
  const pending = new Map<number, Pending>();
  const fail = (why: string) => {
    if (channels.get(runner)?.socket === socket) channels.delete(runner);
    for (const [id, call] of pending) { clearTimeout(call.timer); pending.delete(id); call.reject(new RunnerUnreachableError(`runner ${runner}: ${why}`)); }
  };
  const open = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => { reject(new RunnerUnreachableError(`runner ${runner} has no call channel`)); fail("the call channel failed"); };
  });
  open.catch(() => {});
  socket.onclose = event => fail(`the call channel closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
  socket.onmessage = event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const call = pending.get(message?.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error !== undefined) call.reject(new Error(String(message.error)));
    else call.resolve(message.result);
  };
  const made = { socket, open, pending };
  channels.set(runner, made);
  return made;
}

/**
 * One call on `runner`'s machine. Rejects with RunnerUnreachableError when the runner cannot answer
 * within `timeoutMs` (opening the channel included). A launch passes a longer limit than the
 * runner's own supervisor wait, so a slow start is answered rather than abandoned.
 */
export async function runnerMachineCall<T = any>(runner: string, method: string, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  const current = channel(runner);
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      current.pending.delete(id);
      reject(new RunnerUnreachableError(`runner ${runner} did not answer ${method} within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    current.open.then(() => {
      if (expired) return; // never sent: a late send after the caller gave up would act unseen
      current.pending.set(id, { resolve, reject, timer });
      try { current.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { current.pending.delete(id); clearTimeout(timer); reject(new RunnerUnreachableError(String(error))); }
    }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Close every call channel (checks; the gateway's own stop also ends them). */
export function closeRunnerMachineCalls() {
  for (const { socket } of channels.values()) try { socket.close(1000, "the owner is stopping"); } catch { /* already closed */ }
  channels.clear();
}

/**
 * The runner's side of one channel: answer each call with `handle`, in any order. A handler's error
 * becomes the call's error; the channel stays open.
 */
export function serveRunnerMachineCalls(socket: WebSocket, handle: (method: string, params: any) => Promise<unknown>) {
  socket.onmessage = event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (typeof message?.id !== "number" || typeof message.method !== "string") return;
    void handle(message.method, message.params ?? {}).then(
      result => ({ id: message.id, result: result ?? null }),
      error => ({ id: message.id, error: error instanceof Error ? error.message : String(error) }),
    ).then(answer => {
      try { socket.send(JSON.stringify(answer)); }
      catch (error) { log("warn", "runner_machine_call_unanswered", { method: message.method, error: String(error) }); }
    });
  };
}
