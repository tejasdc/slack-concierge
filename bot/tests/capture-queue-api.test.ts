import { afterEach, beforeEach, expect, test } from "bun:test";
import { createCaptureQueueRequestHandler } from "../src/capture-queue-api";
import {
  captureDb,
  claimCaptureEvent,
  createCaptureEvent,
  getCaptureEvent,
} from "../src/capture-state";
import { processIdentity, readBootId } from "../src/runtime-identity";
import { acquireDatabaseTestLock } from "./db-lock";

const queueToken = "test-queue-token-with-at-least-24-characters";
const handler = createCaptureQueueRequestHandler({ host: "127.0.0.1", port: 8081, token: queueToken });
const owner = processIdentity(process.pid);
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
  return createCaptureEvent({
    eventId,
    routeId: "pebble-index",
    destinationChannel: "C123",
    messageText: `capture ${eventId}`,
    recordedAtMs: 1_787_000_000_000,
    sourceClient: "ring",
    clientMessageId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
  });
}

function ownerBody(value = owner) {
  return { pid: value.pid, boot_id: value.bootId, start_ticks: value.startTicks };
}

function queueRequest(path: string, body?: Record<string, unknown>, token = queueToken) {
  return new Request(`http://127.0.0.1:8081${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("the queue API is authenticated and health is private", async () => {
  expect((await handler(queueRequest("/health", undefined, "wrong-token"))).status).toBe(401);
  expect(await (await handler(queueRequest("/health"))).json()).toEqual({ ok: true });
  expect((await handler(queueRequest("/unknown", {}))).status).toBe(404);
});

test("a committed claim response can be dropped and reattached by stable claim ID", async () => {
  create("claim-drop");
  const body = { claim_id: "claim-drop-request", owner: ownerBody() };
  const dropped = await handler(queueRequest("/claim", body));
  expect(dropped.status).toBe(200);
  expect(getCaptureEvent("claim-drop")).toMatchObject({
    status: "sending",
    delivery_claim_id: "claim-drop-request",
    delivery_attempts: 1,
  });

  const repeated: any = await (await handler(queueRequest("/claim", body))).json();
  expect(repeated.event).toMatchObject({ event_id: "claim-drop", delivery_claim_id: "claim-drop-request" });
  expect(getCaptureEvent("claim-drop")?.delivery_attempts).toBe(1);
});

test("delivered, retry, and park acknowledgements are owner-bound and idempotent after dropped responses", async () => {
  for (const operation of ["delivered", "retry", "park"] as const) {
    const eventId = `${operation}-drop`;
    const claimId = `${operation}-claim`;
    create(eventId);
    const claimBody = { claim_id: claimId, owner: ownerBody() };
    expect((await handler(queueRequest("/claim", claimBody))).status).toBe(200);
    const fields = operation === "delivered"
      ? { slack_message_ts: "1787000000.000001" }
      : operation === "retry"
        ? { error: "temporary", next_attempt_ms: Date.now() + 1_000 }
        : { error: "invalid_auth" };
    const acknowledgement = { ...claimBody, ...fields };
    const first: any = await (await handler(queueRequest(`/events/${eventId}/${operation}`, acknowledgement))).json();
    expect(first).toMatchObject({ ok: true, outcome: "applied" });
    const repeated: any = await (await handler(queueRequest(`/events/${eventId}/${operation}`, acknowledgement))).json();
    expect(repeated).toMatchObject({ ok: true, outcome: "already_applied" });
    const wrongOwner = { ...acknowledgement, owner: ownerBody({ ...owner, startTicks: `${owner.startTicks}0` }) };
    expect((await handler(queueRequest(`/events/${eventId}/${operation}`, wrongOwner))).status).toBe(409);
  }
  expect(getCaptureEvent("delivered-drop")).toMatchObject({ status: "delivered", slack_message_ts: "1787000000.000001" });
  expect(getCaptureEvent("retry-drop")).toMatchObject({ status: "pending", delivery_error: "temporary" });
  expect(getCaptureEvent("park-drop")).toMatchObject({ status: "parked", delivery_error: "invalid_auth" });
});

test("claim-next recovers only a proven-dead owner and respects the deployment gate", async () => {
  create("orphaned");
  const deadOwner = { pid: 2_147_483_647, bootId: readBootId(), startTicks: "1" };
  expect(claimCaptureEvent("orphaned", Date.now(), deadOwner, "dead-claim")).not.toBeNull();
  const recovered: any = await (await handler(queueRequest("/claim", {
    claim_id: "replacement-claim",
    owner: ownerBody(),
  }))).json();
  expect(recovered.event).toMatchObject({ event_id: "orphaned", delivery_claim_id: "replacement-claim" });

  captureDb.query("UPDATE capture_events SET status='pending', delivery_claim_id=NULL WHERE event_id='orphaned'").run();
  captureDb.query(`
    INSERT INTO capture_delivery_gate (singleton, token, owner_pid, owner_boot_id, owner_start_ticks, mode)
    VALUES (1, 'held', ?, ?, ?, 'held')
  `).run(owner.pid, owner.bootId, owner.startTicks);
  expect((await handler(queueRequest("/claim", { claim_id: "blocked-claim", owner: ownerBody() }))).status).toBe(204);
  expect(getCaptureEvent("orphaned")?.status).toBe("pending");
});
