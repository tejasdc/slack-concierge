import { afterEach, beforeEach, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import {
  captureDb,
  claimCaptureEvent,
  createCaptureEvent,
  getCaptureEvent,
  markCaptureEventRetry,
} from "../src/capture-state";
import { processIdentity } from "../src/runtime-identity";

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
    messageText: "capture",
    recordedAtMs: 1_787_000_000_000,
    sourceClient: "ring",
    clientMessageId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
  });
}

function drainCommand(command: "claim" | "hold" | "release-live" | "release", token?: string) {
  const script = `${process.cwd()}/scripts/capture-drain-status.ts`;
  const shell = command === "claim"
    ? 'owner_pid=$BASHPID; exec "$1" run "$2" claim --owner-pid "$owner_pid" --adopt-held'
    : `exec "$1" run "$2" ${command} "$3"`;
  return Bun.spawnSync({
    cmd: ["bash", "-c", shell, "test", "/root/.bun/bin/bun", script, token || ""],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("a drain claim atomically waits for sending captures and then excludes new delivery claims", () => {
  create("in-flight");
  const owner = processIdentity(process.pid);
  expect(claimCaptureEvent("in-flight", Date.now(), owner, "in-flight-claim")).not.toBeNull();
  const blocked = drainCommand("claim");
  expect(blocked.exitCode).toBe(10);
  expect(JSON.parse(blocked.stdout.toString())).toMatchObject({ status: "active", sending_captures: 1 });
  expect(captureDb.query("SELECT * FROM capture_delivery_gate").get()).toBeNull();

  expect(markCaptureEventRetry({ eventId: "in-flight", claimId: "in-flight-claim", owner }, "test handoff", 0)?.outcome).toBe("applied");
  const claimed = drainCommand("claim");
  expect(claimed.exitCode).toBe(0);
  const payload = JSON.parse(claimed.stdout.toString());
  expect(payload).toMatchObject({ status: "claimed_drained", sending_captures: 0 });

  create("after-gate");
  expect(claimCaptureEvent("after-gate")).toBeNull();
  expect(getCaptureEvent("after-gate")?.status).toBe("pending");
  expect(drainCommand("release", payload.token).exitCode).toBe(0);
  expect(claimCaptureEvent("after-gate")).not.toBeNull();
});

test("a dead delivery owner is recovered before the gate is claimed and replay keeps its client id", async () => {
  create("orphaned");
  const child = Bun.spawn(["sleep", "30"]);
  const owner = processIdentity(child.pid);
  expect(claimCaptureEvent("orphaned", Date.now(), owner)).toMatchObject({ status: "sending" });
  expect(drainCommand("claim").exitCode).toBe(10);

  child.kill("SIGKILL");
  await child.exited;
  const claimed = drainCommand("claim");
  expect(claimed.exitCode).toBe(0);
  const payload = JSON.parse(claimed.stdout.toString());
  expect(payload).toMatchObject({ status: "claimed_drained", recovered_captures: 1 });
  expect(getCaptureEvent("orphaned")).toMatchObject({
    status: "pending",
    client_msg_id: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
  });

  expect(drainCommand("release", payload.token).exitCode).toBe(0);
  expect(claimCaptureEvent("orphaned")).toMatchObject({
    status: "sending",
    client_msg_id: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
  });
});

test("a durable failure hold survives its owner and is atomically adopted by the next deploy", () => {
  const first = drainCommand("claim");
  expect(first.exitCode).toBe(0);
  const firstToken = JSON.parse(first.stdout.toString()).token;
  expect(drainCommand("hold", firstToken).exitCode).toBe(0);
  const cleanup = drainCommand("release-live", firstToken);
  expect(cleanup.exitCode).toBe(0);
  expect(JSON.parse(cleanup.stdout.toString())).toMatchObject({ status: "retained_held" });
  expect(captureDb.query("SELECT mode FROM capture_delivery_gate").get()).toEqual({ mode: "held" });

  const adopted = drainCommand("claim");
  expect(adopted.exitCode).toBe(0);
  const adoptedToken = JSON.parse(adopted.stdout.toString()).token;
  expect(adoptedToken).not.toBe(firstToken);
  expect(captureDb.query("SELECT mode FROM capture_delivery_gate").get()).toEqual({ mode: "live" });
  expect(drainCommand("release", adoptedToken).exitCode).toBe(0);
});
