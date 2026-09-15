import { chmodSync } from "node:fs";
import { join } from "node:path";
import { lookupExecutions, type RoutedRequestCoordinator } from "./routed-requests";
import type { SessionCommunicationCoordinator } from './session-communication';
import type {SessionOwner} from './session-owner';

export function startRoutedRequestApi(stateDir: string, coordinator: RoutedRequestCoordinator | null, workspaceUrl?: string | null, sessions?:SessionCommunicationCoordinator,owner?:SessionOwner) {
  const path = join(stateDir, "requests.sock");
  const server = Bun.serve({
    unix: path,
    idleTimeout: 0,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        const native=await owner?.handle(request);
        if(native)return native;
        if (request.method === 'POST' && url.pathname.startsWith('/session-communication/') && sessions) {
          const operation = url.pathname.slice('/session-communication/'.length);
          const input = await request.json();
          if (operation === 'search') return Response.json(await sessions.search(input));
          if (operation === 'context') return Response.json(await sessions.context(input));
          if (operation === 'ask') return Response.json(sessions.ask(input), {status:202});
          if (operation === 'reply') return Response.json(sessions.reply(input));
          if (operation === 'get') return Response.json(sessions.get(input));
        }
        if(!coordinator)return Response.json({error:'Slack routing adapter is unavailable.'},{status:409});
        if (request.method === 'POST' && /^\/requests\/[0-9a-f-]+\/recover$/.test(url.pathname)) {
          return Response.json(await coordinator.recoverRequest(url.pathname.split('/')[2]!));
        }
        if (request.method === 'POST' && url.pathname === '/requests') {
          return Response.json(await coordinator.submit(await request.json()));
        }
        if (request.method === 'GET' && url.pathname.startsWith('/requests/')) {
          return Response.json(coordinator.result(url.pathname.slice('/requests/'.length)));
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
    },
  });
  chmodSync(path, 0o600);
  return server;
}
