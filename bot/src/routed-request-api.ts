import { chmodSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { lookupExecutions, readRoutedRequest, RETIRED_SLACK_ROUTING, type RoutedRequestCoordinator } from "./routed-requests";
import type { SessionCommunicationCoordinator } from './session-communication';
import type {SessionOwner} from './session-owner';

// macOS has no /proc: the only proof that nothing listens on a leftover socket entry is
// a refused connection to it. A connection that opens proves a live listener.
function socketHasListener(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function removeUnboundSocket(path: string) {
  let original;
  try { original = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!original.isSocket()) throw new Error("The request API path is not a socket; refusing to replace it.");
  if (process.platform === "darwin") {
    if (await socketHasListener(path)) throw new Error("The request API already has a live listener.");
  } else {
    // Bun's Unix connect errors conflate missing/refused endpoints. The Linux
    // kernel retains a bound entry even before listen(), and removes it on close.
    const boundPaths = readFileSync("/proc/net/unix", "utf8").split("\n")
      .map(line => line.match(/^\S+(?:\s+\S+){6}\s+(.+)$/)?.[1]);
    if (boundPaths.includes(path)) throw new Error("The request API already has a live listener.");
  }
  const current = lstatSync(path);
  if (!current.isSocket() || current.dev !== original.dev || current.ino !== original.ino) {
    throw new Error("The request API socket changed during startup; refusing to replace it.");
  }
  unlinkSync(path);
}

/** One handler for the owner API and the agent CLI surface; the socket and any peer listener share it. */
export function requestApiHandler(_coordinator: RoutedRequestCoordinator | null, workspaceUrl?: string | null, sessions?:SessionCommunicationCoordinator,owner?:SessionOwner) {
  return async function fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const native=await owner?.handle(request);
      if(native)return native;
      if (request.method === 'POST' && url.pathname.startsWith('/session-communication/') && sessions) {
        const operation = url.pathname.slice('/session-communication/'.length);
        const input = await request.json();
        if (operation === 'search') return Response.json(await sessions.search(input));
        if (operation === 'projects') return Response.json(await sessions.projects(input));
        if (operation === 'peers') return Response.json(await sessions.peerInventory(input));
        if (operation === 'note') return Response.json(await sessions.note(input));
        if (operation === 'title') return Response.json(sessions.title(input));
        if (operation === 'post') return Response.json(sessions.post(input));
        if (operation === 'context') return Response.json(await sessions.context(input));
        if (operation === 'ask') return Response.json(await sessions.ask(input), {status:202});
        if (operation === 'reply') return Response.json(await sessions.reply(input));
        if (operation === 'get') return Response.json(sessions.get(input));
      }
      if (request.method === 'POST' && (url.pathname === '/requests' || /^\/requests\/[0-9a-f-]+\/recover$/.test(url.pathname)))
        return Response.json({error:RETIRED_SLACK_ROUTING,code:'slack_routing_retired'},{status:410});
      if (request.method === 'GET' && url.pathname.startsWith('/requests/')) {
        return Response.json(readRoutedRequest(url.pathname.slice('/requests/'.length)));
      }
      if (request.method === 'GET' && url.pathname === '/executions') {
        const parameters = url.searchParams;
        return Response.json(lookupExecutions({ channel: parameters.get('channel') || '', beforeTs: parameters.get('before_ts') || '',
          rootTs: parameters.get('root_ts') || undefined,
          sessionId: parameters.has('session_id') ? Number(parameters.get('session_id')) : undefined,
          turnId: parameters.has('turn_id') ? Number(parameters.get('turn_id')) : undefined }, workspaceUrl));
      }
      return Response.json({ error: 'Unknown request API route.' }, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Request API failed.' }, { status: 400 });
    }
  };
}

export async function startRoutedRequestApi(stateDir: string, coordinator: RoutedRequestCoordinator | null, workspaceUrl?: string | null, sessions?:SessionCommunicationCoordinator,owner?:SessionOwner) {
  const path = join(stateDir, "requests.sock");
  // A killed listener leaves its filesystem entry behind; normal close removes it.
  await removeUnboundSocket(path);
  const server = Bun.serve({
    unix: path,
    idleTimeout: 0,
    fetch: requestApiHandler(coordinator, workspaceUrl, sessions, owner),
  });
  chmodSync(path, 0o600);
  return server;
}
