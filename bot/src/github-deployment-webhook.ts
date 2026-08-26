import { createHmac, timingSafeEqual } from "node:crypto";

export const GITHUB_DEPLOYMENT_WEBHOOK_PATH = "/github/slack-concierge-deploy";
const MAX_GITHUB_WEBHOOK_BYTES = 1_048_576;

export interface GitHubDeploymentPush {
  deliveryId: string;
  repository: string;
  ref: string;
  after: string;
}

interface GitHubDeploymentWebhookOptions {
  secret: string;
  forward(push: GitHubDeploymentPush): Promise<void>;
  repository?: string;
  ref?: string;
}

class GitHubWebhookRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function jsonResponse(status: number, payload: Record<string, unknown>) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

function validSignature(body: Uint8Array, supplied: string, secret: string) {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function requiredDeliveryId(request: Request) {
  const deliveryId = (request.headers.get("x-github-delivery") || "").trim();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)) {
    throw new GitHubWebhookRequestError(422, "missing or invalid GitHub delivery ID");
  }
  return deliveryId;
}

async function readBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_WEBHOOK_BYTES) {
    throw new GitHubWebhookRequestError(413, "GitHub webhook body is too large");
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_GITHUB_WEBHOOK_BYTES) {
    throw new GitHubWebhookRequestError(413, "GitHub webhook body is too large");
  }
  return body;
}

export function createGitHubDeploymentWebhookHandler(options: GitHubDeploymentWebhookOptions) {
  const expectedRepository = options.repository || "tejasdc/slack-concierge";
  const expectedRef = options.ref || "refs/heads/main";
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }
    try {
      const deliveryId = requiredDeliveryId(request);
      const body = await readBody(request);
      const signature = request.headers.get("x-hub-signature-256") || "";
      if (!validSignature(body, signature, options.secret)) {
        return jsonResponse(401, { error: "invalid_signature" });
      }
      let payload: any;
      try {
        payload = JSON.parse(Buffer.from(body).toString("utf8"));
      } catch {
        throw new GitHubWebhookRequestError(400, "malformed JSON");
      }
      if (payload?.repository?.full_name !== expectedRepository) {
        throw new GitHubWebhookRequestError(422, "unexpected repository");
      }
      const event = (request.headers.get("x-github-event") || "").trim();
      if (event === "ping") {
        return jsonResponse(200, { accepted: true, event: "ping", delivery_id: deliveryId });
      }
      if (event !== "push") {
        throw new GitHubWebhookRequestError(422, "unexpected GitHub event");
      }
      if (payload.ref !== expectedRef || payload.deleted === true) {
        throw new GitHubWebhookRequestError(422, "unexpected Git ref");
      }
      const after = String(payload.after || "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(after) || /^0+$/.test(after)) {
        throw new GitHubWebhookRequestError(422, "invalid push commit");
      }
      await options.forward({
        deliveryId,
        repository: expectedRepository,
        ref: expectedRef,
        after,
      });
      return jsonResponse(202, { accepted: true, event: "push", delivery_id: deliveryId });
    } catch (error) {
      if (error instanceof GitHubWebhookRequestError) {
        return jsonResponse(error.status, { error: error.message });
      }
      return jsonResponse(503, { error: "deployment_receiver_unavailable" });
    }
  };
}

