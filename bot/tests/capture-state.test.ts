import { afterEach, beforeEach, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import {
  claimCaptureEvent,
  captureDeliveryIsDraining,
  captureDb,
  createCaptureEvent,
  getCaptureEvent,
  listRecoverableCaptureEvents,
  markCaptureEventDelivered,
  markCaptureEventRetry,
  parkCaptureEvent,
  recoverInterruptedCaptureDeliveries,
} from "../src/capture-state";
import { processIdentity, readBootId } from "../src/runtime-identity";

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

function create(eventId = "capture-1") {
  return createCaptureEvent({
    eventId,
    routeId: "pebble-index",
    destinationChannel: "C123",
    messageText: "captured text",
    recordedAtMs: 1_787_000_000_000,
    sourceClient: "ring",
    clientMessageId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
  });
}

function proof(eventId: string, claimId: string, owner = processIdentity(process.pid)) {
  return { eventId, claimId, owner };
}

test("capture events are idempotent and preserve their first durable payload", () => {
  expect(create().created).toBe(true);
  const duplicate = createCaptureEvent({
    eventId: "capture-1",
    routeId: "changed-route",
    destinationChannel: "C999",
    messageText: "changed text",
    recordedAtMs: 1,
    sourceClient: "changed",
    clientMessageId: "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb",
  });
  expect(duplicate.created).toBe(false);
  expect(duplicate.event).toMatchObject({
    route_id: "pebble-index",
    destination_channel: "C123",
    message_text: "captured text",
    status: "pending",
  });
});

test("a transient delivery can be retried and completed without losing its claim", () => {
  create();
  const firstClaim = proof("capture-1", "first-claim");
  const first = claimCaptureEvent("capture-1", 100, firstClaim.owner, firstClaim.claimId);
  expect(first).toMatchObject({ status: "sending", delivery_attempts: 1 });
  expect(markCaptureEventRetry(firstClaim, "temporarily unavailable", 500)?.outcome).toBe("applied");
  expect(markCaptureEventRetry(firstClaim, "temporarily unavailable", 500)?.outcome).toBe("already_applied");
  expect(claimCaptureEvent("capture-1", 499)).toBeNull();
  const secondClaim = proof("capture-1", "second-claim");
  const second = claimCaptureEvent("capture-1", 500, secondClaim.owner, secondClaim.claimId);
  expect(second).toMatchObject({ status: "sending", delivery_attempts: 2 });
  expect(markCaptureEventDelivered(secondClaim, "1787000000.000001")?.outcome).toBe("applied");
  expect(markCaptureEventDelivered(secondClaim, "1787000000.000001")?.outcome).toBe("already_applied");
  expect(getCaptureEvent("capture-1")).toMatchObject({
    status: "delivered",
    slack_message_ts: "1787000000.000001",
    delivery_error: null,
  });
  expect(listRecoverableCaptureEvents()).toEqual([]);
});

test("startup recovers an interrupted sending lease and permanent errors park", () => {
  create("interrupted");
  const deadOwner = {
    pid: 2_147_483_647,
    bootId: readBootId(),
    startTicks: "1",
  };
  expect(claimCaptureEvent("interrupted", Date.now(), deadOwner, "dead-claim")).not.toBeNull();
  expect(recoverInterruptedCaptureDeliveries()).toBe(1);
  expect(getCaptureEvent("interrupted")).toMatchObject({ status: "pending" });
  const liveClaim = proof("interrupted", "live-claim");
  expect(claimCaptureEvent("interrupted", Date.now(), liveClaim.owner, liveClaim.claimId)).not.toBeNull();
  expect(parkCaptureEvent(liveClaim, "invalid_auth")?.outcome).toBe("applied");
  expect(parkCaptureEvent(liveClaim, "invalid_auth")?.outcome).toBe("already_applied");
  expect(getCaptureEvent("interrupted")).toMatchObject({ status: "parked", delivery_error: "invalid_auth" });
});

test("startup never steals a sending lease from a live delivery owner", () => {
  create("live-owner");
  expect(claimCaptureEvent("live-owner")).not.toBeNull();
  expect(recoverInterruptedCaptureDeliveries()).toBe(0);
  expect(getCaptureEvent("live-owner")).toMatchObject({
    status: "sending",
    delivery_owner_pid: process.pid,
  });
});

test("the deployment gate blocks capture delivery without rejecting ingress persistence", () => {
  expect(captureDeliveryIsDraining()).toBe(false);
  const owner = processIdentity(process.pid);
  captureDb.query(`
    INSERT INTO capture_delivery_gate (singleton, token, owner_pid, owner_boot_id, owner_start_ticks)
    VALUES (1, 'deploying', ?, ?, ?)
  `).run(owner.pid, owner.bootId, owner.startTicks);
  expect(captureDeliveryIsDraining()).toBe(true);
  expect(create("queued-during-deploy").event.status).toBe("pending");
  expect(claimCaptureEvent("queued-during-deploy")).toBeNull();
  expect(getCaptureEvent("queued-during-deploy")?.status).toBe("pending");
});
