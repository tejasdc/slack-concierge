import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const receipt = { kind: "slack" as const, slackMessageTs: "1787000000.000001" };
  expect(markCaptureEventDelivered(secondClaim, receipt)?.outcome).toBe("applied");
  expect(markCaptureEventDelivered(secondClaim, receipt)?.outcome).toBe("already_applied");
  expect(getCaptureEvent("capture-1")).toMatchObject({
    status: "delivered",
    slack_message_ts: "1787000000.000001",
    delivery_error: null,
  });
  expect(listRecoverableCaptureEvents()).toEqual([]);
});

test("journal captures require coherent provenance, destination, and terminal receipts", () => {
  const eventId = "b".repeat(64);
  const created = createCaptureEvent({
    eventId,
    routeId: "pebble-index",
    destinationChannel: "",
    messageText: "---\nsource: pebble-index\n---\nthought\n",
    recordedAtMs: 1_787_000_000_000,
    sourceClient: "ring",
    sourceTrigger: "single-click-hold",
    sourceWebhookVersion: "1",
    clientMessageId: "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb",
    deliveryKind: "journal",
    journalSink: "journalmaxx-inbox",
  });
  expect(created.event).toMatchObject({
    delivery_kind: "journal",
    destination_channel: "",
    journal_sink: "journalmaxx-inbox",
    journal_file_path: null,
    source_trigger: "single-click-hold",
    source_webhook_version: "1",
  });
  const claim = proof(eventId, "journal-claim");
  expect(claimCaptureEvent(eventId, Date.now(), claim.owner, claim.claimId)).not.toBeNull();
  expect(() => markCaptureEventDelivered(claim, {
    kind: "slack",
    slackMessageTs: "1787000000.000001",
  })).toThrow("does not match");
  const receipt = { kind: "journal" as const, journalFilePath: `pebble-${eventId}.md` };
  expect(markCaptureEventDelivered(claim, receipt)?.outcome).toBe("applied");
  expect(markCaptureEventDelivered(claim, receipt)?.outcome).toBe("already_applied");
  expect(() => markCaptureEventDelivered(claim, {
    kind: "journal",
    journalFilePath: "different.md",
  })).toThrow("does not match its durable event identity");
  expect(getCaptureEvent(eventId)).toMatchObject({
    status: "delivered",
    journal_file_path: `pebble-${eventId}.md`,
    slack_message_ts: null,
  });

  expect(() => createCaptureEvent({
    eventId: "invalid-partial",
    routeId: "pebble-index",
    destinationChannel: "C123",
    messageText: "capture",
    recordedAtMs: 1,
    sourceClient: "ring",
    sourceTrigger: "single-click-hold",
    clientMessageId: "cccccccc-cccc-4ccc-accc-cccccccccccc",
  })).toThrow("Invalid capture event field combination");
  expect(() => captureDb.query(`
    INSERT INTO capture_events (
      event_id, route_id, destination_channel, message_text, recorded_at_ms,
      source_client, client_msg_id, delivery_kind, journal_sink
    ) VALUES ('invalid-direct', 'pebble-index', 'C123', 'capture', 1,
      'ring', 'dddddddd-dddd-4ddd-addd-dddddddddddd', 'journal', 'journalmaxx-inbox')
  `).run()).toThrow("invalid capture event field combination");
  expect(() => captureDb.query(`
    INSERT INTO capture_events (
      event_id, route_id, destination_channel, message_text, recorded_at_ms,
      source_client, client_msg_id, delivery_kind, status
    ) VALUES ('invalid-delivered-slack', 'pebble-index', 'C123', 'capture', 1,
      'ring', 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee', 'slack', 'delivered')
  `).run()).toThrow("invalid capture event field combination");
});

test("schema migration preserves historical Slack rows with compatible defaults", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "capture-state-migration-"));
  mkdirSync(stateDir, { recursive: true });
  const legacy = new Database(join(stateDir, "state.db"), { create: true });
  legacy.exec(`
    CREATE TABLE capture_events (
      event_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      destination_channel TEXT NOT NULL,
      message_text TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      source_client TEXT NOT NULL,
      client_msg_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_error TEXT,
      next_attempt_ms INTEGER,
      slack_message_ts TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at DATETIME,
      parked_at DATETIME
    );
    INSERT INTO capture_events (
      event_id, route_id, destination_channel, message_text,
      recorded_at_ms, source_client, client_msg_id, status, slack_message_ts
    ) VALUES (
      'legacy', 'pebble-index', 'C123', 'legacy capture',
      1787000000000, 'ring', 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee',
      'delivered', '1787000000.000001'
    );
  `);
  legacy.close();
  const probe = Bun.spawnSync({
    cmd: [process.execPath, "-e", [
      'import { getCaptureEvent } from "./src/capture-state.ts";',
      'console.log(JSON.stringify(getCaptureEvent("legacy")));',
    ].join(" ")],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      CONCIERGE_CAPTURE_STATE_DIR: stateDir,
      CONCIERGE_TEST_MODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(probe.exitCode, probe.stderr.toString()).toBe(0);
  expect(JSON.parse(probe.stdout.toString())).toMatchObject({
    event_id: "legacy",
    destination_channel: "C123",
    delivery_kind: "slack",
    journal_sink: null,
    journal_file_path: null,
    source_trigger: null,
    source_webhook_version: null,
    slack_message_ts: "1787000000.000001",
  });
  rmSync(stateDir, { recursive: true, force: true });
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
