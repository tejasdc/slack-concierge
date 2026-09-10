import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import type { Action } from "./router-post";

export async function requestApi(path: string, body?: unknown) {
  const database = process.env.CONCIERGE_STATE_DB || '/root/.local/state/concierge/state.db';
  const response = await fetch(`http://localhost${path}`, {
    unix: join(realpathSync(dirname(database)), 'requests.sock'),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result: any = await response.json();
  if (!response.ok) throw new Error(result.error || 'Concierge request API rejected the request.');
  return result;
}

export function submitRouterRequest(action: Action) {
  if (!action.sourceChannel || !action.sourceTs) throw new Error('Routed posts require --source-channel and --source-ts from this exact Slack input.');
  return requestApi('/requests', {
    source: { channel_id: action.sourceChannel, message_ts: action.sourceTs }, action_id: action.actionId || 'primary',
    destination: { channel_id: action.channel, root_ts: action.threadTs || null }, task: action.text,
    defer: action.defer || false, depends_on: action.dependencies || [], files: action.filePaths,
  });
}

export async function runRouterWork(args: string[]) {
  if (args[0] === 'recover' && args.length === 2) return requestApi(`/requests/${encodeURIComponent(args[1]!)}/recover`, {});
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
