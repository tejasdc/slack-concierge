import { chmodSync } from "node:fs";
import { join } from "node:path";
import { lookupExecutions, type RoutedRequestCoordinator } from "./routed-requests";

export function startRoutedRequestApi(stateDir: string, coordinator: RoutedRequestCoordinator, workspaceUrl?: string | null) {
  const path = join(stateDir, "requests.sock");
  const server = Bun.serve({
    unix: path,
    idleTimeout: 0,
    async fetch(request) {
      try {
        const url = new URL(request.url);
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
