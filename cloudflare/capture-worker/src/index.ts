interface CaptureEdgeEnvironment {
  ORIGIN_BASE_URL: string;
}

type UpstreamFetch = (request: Request) => Promise<Response>;

const METHODS_BY_PATH = new Map([
  ["/pebble", "POST"],
  ["/health", "GET"],
]);

export function createCaptureEdgeHandler(upstreamFetch: UpstreamFetch = fetch) {
  return async (request: Request, environment: CaptureEdgeEnvironment): Promise<Response> => {
    const incoming = new URL(request.url);
    const expectedMethod = METHODS_BY_PATH.get(incoming.pathname);
    if (!expectedMethod || incoming.search) return new Response("not found", { status: 404 });
    if (request.method !== expectedMethod) {
      return new Response("method not allowed", { status: 405, headers: { allow: expectedMethod } });
    }
    const origin = new URL(environment.ORIGIN_BASE_URL);
    origin.pathname = incoming.pathname;
    origin.search = "";
    const upstreamRequest = new Request(origin, request);
    return upstreamFetch(upstreamRequest);
  };
}

const handleCaptureEdgeRequest = createCaptureEdgeHandler();

export default {
  fetch(request: Request, environment: CaptureEdgeEnvironment) {
    return handleCaptureEdgeRequest(request, environment);
  },
};
