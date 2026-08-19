import { afterEach, beforeEach, expect, test } from "bun:test";
import { CaptureDeliveryWorker, postCaptureToSlack } from "../src/capture-delivery-worker";
import { createCaptureQueueRequestHandler } from "../src/capture-queue-api";
import { captureDb, createCaptureEvent, getCaptureEvent, recoverInterruptedCaptureDeliveries } from "../src/capture-state";
import { processIdentity, readBootId } from "../src/runtime-identity";
import { acquireDatabaseTestLock } from "./db-lock";

const queueToken = "test-queue-token-with-at-least-24-characters";
const userToken = "xoxp-test-user-token-with-at-least-24-characters";
const queueHandler = createCaptureQueueRequestHandler({ host: "127.0.0.1", port: 8081, token: queueToken });
let releaseDatabaseTestLock: (() => void) | null = null;

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  captureDb.query("DELETE FROM capture_delivery_gate").run();
  captureDb.query("DELETE FROM capture_events").run();
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

function create(eventId: string) {
  createCaptureEvent({
    eventId,
    routeId: "pebble-index",
    destinationChannel: "C123",
    messageText: `capture ${eventId} <@U123>`,
    recordedAtMs: 1_787_000_000_000,
    sourceClient: "ring",
    clientMessageId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
  });
}

async function waitForState(eventId: string, status: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (getCaptureEvent(eventId)?.status === status) return;
    await Bun.sleep(2);
  }
  throw new Error(`Timed out waiting for ${eventId} to become ${status}`);
}

function workerFetch(input: {
  slackResponses?: Response[];
  requests?: Array<{ url: string; body: any; authorization: string }>;
  dropAfterCommit?: Set<string>;
}) {
  const dropped = new Set<string>();
  return async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = typeof urlInput === "string" || urlInput instanceof URL ? String(urlInput) : urlInput.url;
    if (url === "https://slack.com/api/auth.test") {
      return Response.json({ ok: true, user_id: "U123" });
    }
    if (url === "https://slack.com/api/chat.postMessage") {
      input.requests?.push({
        url,
        body: JSON.parse(String(init?.body)),
        authorization: String(new Headers(init?.headers).get("authorization")),
      });
      return input.slackResponses?.shift() || Response.json({ ok: true, ts: "1787000000.000001" });
    }
    if (url.startsWith("http://queue.test")) {
      const response = await queueHandler(new Request(url, init));
      const path = new URL(url).pathname;
      if (input.dropAfterCommit?.has(path) && response.ok && !dropped.has(path)) {
        dropped.add(path);
        throw new Error(`simulated dropped ${path} response`);
      }
      return response;
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

function worker(fetchImpl: typeof fetch, onFatal?: (error: unknown) => void, owner = processIdentity(process.pid)) {
  return new CaptureDeliveryWorker({
    queueUrl: "http://queue.test",
    queueToken,
    slackUserToken: userToken,
    owner,
    fetch: fetchImpl,
    wait: async () => { await Bun.sleep(1); },
    pollIntervalMs: 1,
    onFatal,
  });
}

test("Concierge posts with its existing user token and preserves deterministic Slack identity", async () => {
  create("delivered");
  const requests: Array<{ url: string; body: any; authorization: string }> = [];
  const delivery = worker(workerFetch({ requests }) as typeof fetch);
  await delivery.prepare();
  await delivery.start();
  await waitForState("delivered", "delivered");
  await delivery.stop();

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ authorization: `Bearer ${userToken}` });
  expect(requests[0].body).toMatchObject({
    channel: "C123",
    client_msg_id: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
  });
  expect(getCaptureEvent("delivered")).toMatchObject({ status: "delivered", slack_message_ts: "1787000000.000001" });
});

test("dropped claim and delivered responses reattach without a second Slack post", async () => {
  create("ambiguous-queue");
  const requests: Array<{ url: string; body: any; authorization: string }> = [];
  const delivery = worker(workerFetch({
    requests,
    dropAfterCommit: new Set(["/claim", "/events/ambiguous-queue/delivered"]),
  }) as typeof fetch);
  await delivery.prepare();
  await delivery.start();
  await waitForState("ambiguous-queue", "delivered");
  await delivery.stop();
  expect(requests).toHaveLength(1);
  expect(getCaptureEvent("ambiguous-queue")).toMatchObject({ status: "delivered", delivery_attempts: 1 });
});

test("transient Slack failures retry later and permanent failures park", async () => {
  create("retry");
  const retrying = worker(workerFetch({ slackResponses: [new Response("", { status: 429 })] }) as typeof fetch);
  await retrying.prepare();
  await retrying.start();
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const event = getCaptureEvent("retry");
    if (event?.status === "pending" && event.delivery_attempts === 1 && event.delivery_error) break;
    await Bun.sleep(2);
  }
  await retrying.stop();
  expect(getCaptureEvent("retry")).toMatchObject({ status: "pending", delivery_attempts: 1, delivery_error: expect.stringContaining("rate limited") });

  captureDb.query("DELETE FROM capture_events").run();
  create("park");
  const parking = worker(workerFetch({ slackResponses: [Response.json({ ok: false, error: "invalid_auth" })] }) as typeof fetch);
  await parking.prepare();
  await parking.start();
  await waitForState("park", "parked");
  await parking.stop();
  expect(getCaptureEvent("park")).toMatchObject({ status: "parked", delivery_error: "invalid_auth" });
});

test("readiness fails closed for a wrong queue credential or invalid user token", async () => {
  const wrongQueue = new CaptureDeliveryWorker({
    queueUrl: "http://queue.test",
    queueToken: "wrong-queue-token-with-at-least-24-characters",
    slackUserToken: userToken,
    fetch: workerFetch({}) as typeof fetch,
  });
  await expect(wrongQueue.prepare()).rejects.toThrow("queue readiness failed");

  const invalidUserFetch = async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = typeof urlInput === "string" || urlInput instanceof URL ? String(urlInput) : urlInput.url;
    if (url.startsWith("http://queue.test")) return queueHandler(new Request(url, init));
    return Response.json({ ok: false, error: "invalid_auth" });
  };
  const invalidUser = worker(invalidUserFetch as typeof fetch);
  await expect(invalidUser.prepare()).rejects.toThrow("user_token failed auth.test");
});

test("startup readiness requires a successful first claim before deployment can release", async () => {
  let fatalError: unknown = null;
  let deploymentReleased = false;
  const failingClaimFetch = (async (urlInput: string | URL | Request) => {
    const url = typeof urlInput === "string" || urlInput instanceof URL ? String(urlInput) : urlInput.url;
    if (url === "https://slack.com/api/auth.test") return Response.json({ ok: true, user_id: "U123" });
    if (url.endsWith("/health")) return Response.json({ ok: true });
    if (url.endsWith("/claim")) return Response.json({ error: "invalid_request" }, { status: 400 });
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
  const delivery = worker(failingClaimFetch, (error) => { fatalError = error; });

  await delivery.prepare();
  try {
    await delivery.start();
    deploymentReleased = true;
  } catch (error) {
    expect(String(error)).toContain("claim failed");
  }

  expect(deploymentReleased).toBeFalse();
  expect(String(fatalError)).toContain("claim failed");
});

test("an unrecoverable post-claim failure terminates the worker owner for dead-owner recovery", async () => {
  create("fatal");
  const deadOwner = { pid: 2_147_483_647, bootId: readBootId(), startTicks: "1" };
  let fatalError: unknown = null;
  const fetchImpl = workerFetch({}) as typeof fetch;
  const rejectingAckFetch = (async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = typeof urlInput === "string" || urlInput instanceof URL ? String(urlInput) : urlInput.url;
    if (url.includes("/events/fatal/delivered")) return Response.json({ error: "claim_conflict" }, { status: 409 });
    return fetchImpl(urlInput, init);
  }) as typeof fetch;
  const delivery = worker(rejectingAckFetch, (error) => { fatalError = error; }, deadOwner);
  await delivery.prepare();
  await delivery.start();
  for (let attempt = 0; attempt < 500 && !fatalError; attempt += 1) await Bun.sleep(2);
  expect(String(fatalError)).toContain("claim_conflict");
  expect(getCaptureEvent("fatal")).toMatchObject({ status: "sending", delivery_owner_pid: deadOwner.pid });
  expect(recoverInterruptedCaptureDeliveries()).toBe(1);
  expect(getCaptureEvent("fatal")?.status).toBe("pending");
});

test("Slack requests abort instead of hanging the Concierge worker", async () => {
  const event = {
    destination_channel: "C123",
    message_text: "timeout",
    client_msg_id: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
  } as any;
  await expect(postCaptureToSlack({
    event,
    token: userToken,
    timeoutMs: 5,
    fetch: async (_url, init) => {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return Response.json({ ok: true });
    },
  })).rejects.toThrow("Slack transport failed");
});
