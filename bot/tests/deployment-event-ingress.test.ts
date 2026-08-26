import { expect, test } from "bun:test";
import { createDeploymentEventHandler } from "../src/deployment-event-ingress";

const token = "capture-queue-test-secret-with-enough-bytes";
const push = {
  deliveryId: "delivery-123",
  repository: "tejasdc/slack-concierge",
  ref: "refs/heads/main",
  after: "a".repeat(40),
};

function request(body: unknown, suppliedToken = token) {
  return new Request("http://127.0.0.1:8082/github-push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${suppliedToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("the loopback deployment receiver authenticates and accepts one normalized push", async () => {
  const accepted: unknown[] = [];
  const handler = createDeploymentEventHandler({
    token,
    accept: async (value) => {
      accepted.push(value);
      return { observation: "recorded" };
    },
  });
  const response = await handler(request(push));
  expect(response.status).toBe(202);
  expect(accepted).toEqual([push]);
});

test("the loopback deployment receiver rejects bad auth and malformed envelopes", async () => {
  let accepted = 0;
  const handler = createDeploymentEventHandler({
    token,
    accept: async () => { accepted += 1; return {}; },
  });
  expect((await handler(request(push, "wrong-token-with-enough-bytes"))).status).toBe(401);
  expect((await handler(request({ ...push, repository: "tejasdc/other" }))).status).toBe(503);
  expect(accepted).toBe(0);
});
