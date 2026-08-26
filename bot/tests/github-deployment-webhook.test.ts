import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createGitHubDeploymentWebhookHandler,
  type GitHubDeploymentPush,
} from "../src/github-deployment-webhook";

const secret = "capture-queue-test-secret-with-enough-bytes";
const basePayload = {
  ref: "refs/heads/main",
  after: "a".repeat(40),
  deleted: false,
  repository: { full_name: "tejasdc/slack-concierge" },
};

function signedRequest(event: string, payload: Record<string, unknown>, signatureSecret = secret) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", signatureSecret).update(body).digest("hex")}`;
  return new Request("https://95-217-119-40.sslip.io/github/slack-concierge-deploy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "delivery-123",
      "x-hub-signature-256": signature,
    },
    body,
  });
}

describe("GitHub deployment webhook", () => {
  test("verifies exact raw bytes and forwards only the configured main push", async () => {
    const pushes: GitHubDeploymentPush[] = [];
    const handler = createGitHubDeploymentWebhookHandler({
      secret,
      forward: async (push) => { pushes.push(push); },
    });
    const response = await handler(signedRequest("push", basePayload));
    expect(response.status).toBe(202);
    expect(pushes).toEqual([{
      deliveryId: "delivery-123",
      repository: "tejasdc/slack-concierge",
      ref: "refs/heads/main",
      after: "a".repeat(40),
    }]);
  });

  test("accepts a signed ping without scheduling deployment", async () => {
    let forwarded = 0;
    const handler = createGitHubDeploymentWebhookHandler({
      secret,
      forward: async () => { forwarded += 1; },
    });
    const response = await handler(signedRequest("ping", {
      repository: { full_name: "tejasdc/slack-concierge" },
      zen: "Keep it logically awesome.",
    }));
    expect(response.status).toBe(200);
    expect(forwarded).toBe(0);
  });

  test("rejects invalid signatures, repositories, refs, and event types", async () => {
    let forwarded = 0;
    const handler = createGitHubDeploymentWebhookHandler({
      secret,
      forward: async () => { forwarded += 1; },
    });
    expect((await handler(signedRequest("push", basePayload, "wrong-secret-with-enough-bytes"))).status).toBe(401);
    expect((await handler(signedRequest("push", {
      ...basePayload,
      repository: { full_name: "tejasdc/other" },
    }))).status).toBe(422);
    expect((await handler(signedRequest("push", { ...basePayload, ref: "refs/heads/feature" }))).status).toBe(422);
    expect((await handler(signedRequest("issues", basePayload))).status).toBe(422);
    expect(forwarded).toBe(0);
  });

  test("returns retryable unavailability when the live bot receiver fails", async () => {
    const handler = createGitHubDeploymentWebhookHandler({
      secret,
      forward: async () => { throw new Error("bot offline"); },
    });
    expect((await handler(signedRequest("push", basePayload))).status).toBe(503);
  });
});

