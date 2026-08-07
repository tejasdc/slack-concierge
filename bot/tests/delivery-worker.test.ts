import { afterEach, beforeEach, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import { runDeliveryWorker } from "../src/delivery-worker";
import { isTransientSlackError } from "../src/slack-errors";
import {
  acquireSessionTurn,
  createOrGetSession,
  db,
  deliveredChunkIndexes,
  markDeliveryChunkDelivered,
  markTurnDelivered,
  markTurnDelivering,
  markTurnDeliveryFailed,
  recordDeliveryAttempt,
  parkTurnDelivery,
  relinquishTurnDelivery,
} from "../src/state";

let releaseDatabaseTestLock: (() => void) | null = null;
beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
});
afterEach(() => { releaseDatabaseTestLock?.(); releaseDatabaseTestLock = null; });

test("transient Slack failure resumes chunks and releases the session without restart", async () => {
  const session = createOrGetSession("C1", "900.000001", "codex");
  const turn = acquireSessionTurn(session.id, "900.000002", "work", "runtime-live");
  markTurnDelivering(turn.id, "agent output", "rendered output", 2);
  let calls = 0;
  const waits: number[] = [];

  const outcome = await runDeliveryWorker({
    initialDelayMs: 1,
    maximumDelayMs: 2,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    recordAttempt: () => recordDeliveryAttempt(turn.id, null),
    recordFailure: (error) => markTurnDeliveryFailed(turn.id, String(error)),
    attempt: async () => {
      calls += 1;
      const delivered = deliveredChunkIndexes(turn.id);
      if (!delivered.has(0)) markDeliveryChunkDelivered(turn.id, 0, "900.000003");
      if (calls === 1) throw new Error("transient Slack failure");
      expect(deliveredChunkIndexes(turn.id)).toEqual(new Set([0]));
      markDeliveryChunkDelivered(turn.id, 1, "900.000004");
    },
  });
  expect(outcome).toBe("delivered");
  markTurnDelivered(turn.id);

  expect(calls).toBe(2);
  expect(waits).toEqual([1]);
  expect((db.query("SELECT status, delivery_status, delivery_attempts FROM turns WHERE id=?").get(turn.id) as any))
    .toMatchObject({ status: "done", delivery_status: "delivered", delivery_attempts: 2 });
  expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("idle");
  expect((db.query("SELECT COUNT(*) AS count FROM turns WHERE status IN ('running','delivering')").get() as any).count).toBe(0);
  const drain = Bun.spawnSync(["/root/.bun/bin/bun", "scripts/drain-status.ts", "check"], {
    cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe",
  });
  expect(drain.exitCode).toBe(0);
  expect(JSON.parse(drain.stdout.toString()).status).toBe("drained");
});

test("shutdown predicate stops before starting another delivery attempt", async () => {
  let attempts = 0;
  const outcome = await runDeliveryWorker({
    shouldStop: () => true,
    recordAttempt: () => { attempts += 1; },
    recordFailure: () => {},
    attempt: async () => {},
  });
  expect(outcome).toBe("stopped");
  expect(attempts).toBe(0);
});

test("permanent Slack failure parks audit state and releases the session", async () => {
  const session = createOrGetSession("C1", "910.000001", "codex");
  const turn = acquireSessionTurn(session.id, "910.000002", "work", "runtime-live");
  markTurnDelivering(turn.id, "agent output", "rendered output", 1);
  const permanent = Object.assign(new Error("missing_scope"), { data: { error: "missing_scope" } });

  const outcome = await runDeliveryWorker({
    recordAttempt: () => recordDeliveryAttempt(turn.id, null),
    recordFailure: (error) => markTurnDeliveryFailed(turn.id, String(error)),
    isRetryable: isTransientSlackError,
    attempt: async () => { throw permanent; },
  });
  expect(outcome).toBe("permanent_failure");
  expect(parkTurnDelivery(turn.id, "runtime-live")).toBe(true);
  expect((db.query("SELECT status, delivery_status, outbound_text, delivery_error FROM turns WHERE id=?").get(turn.id) as any))
    .toMatchObject({ status: "delivery_parked", delivery_status: "parked", outbound_text: "rendered output" });
  expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("idle");
});

test("Slack error classification retries transport failures but parks API contract errors", () => {
  expect(isTransientSlackError(Object.assign(new Error("rate"), { data: { error: "ratelimited" } }))).toBe(true);
  expect(isTransientSlackError(Object.assign(new Error("request"), { code: "slack_webapi_request_error" }))).toBe(true);
  expect(isTransientSlackError(Object.assign(new Error("http"), { code: "slack_webapi_http_error", statusCode: 503 }))).toBe(true);
  expect(isTransientSlackError(Object.assign(new Error("http"), { code: "slack_webapi_http_error", statusCode: 404 }))).toBe(false);
  expect(isTransientSlackError(Object.assign(new Error("rate"), { code: "slack_webapi_rate_limited_error" }))).toBe(true);
  expect(isTransientSlackError(Object.assign(new Error("scope"), { data: { error: "missing_scope" } }))).toBe(false);
});

test("shutdown during retry relinquishes ownership for next-instance replay", async () => {
  const session = createOrGetSession("C1", "920.000001", "codex");
  const turn = acquireSessionTurn(session.id, "920.000002", "work", "runtime-live");
  markTurnDelivering(turn.id, "agent output", "rendered output", 2);
  let stopping = false;
  const outcome = await runDeliveryWorker({
    shouldStop: () => stopping,
    isRetryable: () => true,
    wait: async () => {},
    recordAttempt: () => recordDeliveryAttempt(turn.id, null),
    recordFailure: (error) => { markTurnDeliveryFailed(turn.id, String(error)); stopping = true; },
    attempt: async () => {
      markDeliveryChunkDelivered(turn.id, 0, "920.000003");
      throw new Error("service_unavailable");
    },
  });
  expect(outcome).toBe("stopped");
  expect(relinquishTurnDelivery(turn.id, "runtime-live")).toBe(true);
  expect((db.query("SELECT status, owner_instance_id FROM turns WHERE id=?").get(turn.id) as any))
    .toMatchObject({ status: "delivering", owner_instance_id: null });
  expect([...deliveredChunkIndexes(turn.id)]).toEqual([0]);
});
