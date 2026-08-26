import { timingSafeEqual } from "node:crypto";
import type { GitHubDeploymentPush } from "./github-deployment-webhook";

export const DEPLOYMENT_EVENT_PATH = "/github-push";

function authorized(request: Request, token: string) {
  const suppliedBytes = Buffer.from(request.headers.get("authorization") || "");
  const expectedBytes = Buffer.from(`Bearer ${token}`);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function jsonResponse(status: number, payload: Record<string, unknown>) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

function parsePush(payload: any): GitHubDeploymentPush {
  const deliveryId = String(payload?.deliveryId || "");
  const repository = String(payload?.repository || "");
  const ref = String(payload?.ref || "");
  const after = String(payload?.after || "").toLowerCase();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)
    || repository !== "tejasdc/slack-concierge"
    || ref !== "refs/heads/main"
    || !/^[0-9a-f]{40}$/.test(after)) {
    throw new Error("invalid deployment push envelope");
  }
  return { deliveryId, repository, ref, after };
}

export function createDeploymentEventHandler(input: {
  token: string;
  accept(push: GitHubDeploymentPush): Promise<Record<string, unknown>>;
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== DEPLOYMENT_EVENT_PATH || url.search) {
      return jsonResponse(404, { error: "not_found" });
    }
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }
    if (!authorized(request, input.token)) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    try {
      const body = await request.text();
      if (Buffer.byteLength(body) > 16_384) return jsonResponse(413, { error: "body_too_large" });
      const result = await input.accept(parsePush(JSON.parse(body)));
      return jsonResponse(202, { accepted: true, ...result });
    } catch (error) {
      return jsonResponse(503, {
        error: "deployment_event_rejected",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function startDeploymentEventIngress(input: {
  token: string;
  accept(push: GitHubDeploymentPush): Promise<Record<string, unknown>>;
  host?: string;
  port?: number;
}) {
  const handler = createDeploymentEventHandler(input);
  return Bun.serve({
    hostname: input.host || "127.0.0.1",
    port: input.port || 8082,
    maxRequestBodySize: 16_384,
    idleTimeout: 10,
    fetch: handler,
  });
}
