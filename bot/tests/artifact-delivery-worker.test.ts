import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanExpiredArtifactStaging, scheduleTurnArtifactDelivery } from "../src/artifact-delivery-worker";
import { artifactDirectoryForTurn, findTurnArtifacts, prepareArtifactDirectory } from "../src/artifacts";
import { slackBucket } from "../src/rate-limit";
import {
  acquireSessionTurn,
  claimTurnArtifactDelivery,
  createOrGetSession,
  createTurnArtifactBatch,
  db,
  finishDeliveredTurn,
  getTurnArtifactBatch,
  getTurnArtifactDelivery,
  getTurnStatusProjection,
  listPendingTurnArtifactDeliveries,
  listTurnArtifactDeliveries,
  markDeliveryChunkDelivered,
  markTurnDelivering,
  markTurnResponseDelivered,
  recoverTurnArtifactDeliveryClaims,
  registerProcessInstance,
  registerTurnArtifactIntents,
  upsertChannel,
} from "../src/state";
import { acquireDatabaseTestLock } from "./db-lock";

let releaseDatabaseTestLock: (() => void) | null = null;
let projectDir = "";

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM turn_artifact_deliveries").run();
  db.query("DELETE FROM turn_artifact_batches").run();
  db.query("DELETE FROM turn_reaction_cleanups").run();
  db.query("DELETE FROM slack_thread_statuses").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
  slackBucket.reset();
  projectDir = mkdtempSync(join(tmpdir(), "concierge-artifact-worker-"));
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

function createDeliveredTurnWithArtifacts(filenames: string[]) {
  upsertChannel({
    slack_channel_id: "C1",
    slack_channel_name: "concierge",
    group_name: null,
    name: "Concierge",
    vault_path: projectDir,
    code_path: projectDir,
  });
  const session = createOrGetSession("C1", "100.000001", "codex");
  const turn = acquireSessionTurn(
    session.id,
    "100.000010",
    "create artifacts",
    "runtime-current",
    undefined,
    "100.000001",
  );
  const token = randomUUID();
  const directory = artifactDirectoryForTurn(projectDir, turn.id, token);
  createTurnArtifactBatch(turn.id, token, directory);
  prepareArtifactDirectory(projectDir, turn.id, token);
  for (const filename of filenames) writeFileSync(join(directory, filename), `content:${filename}`);
  registerTurnArtifactIntents(turn.id, findTurnArtifacts(directory));
  markTurnDelivering(turn.id, "response", "response", 1, "Response delivered.");
  markDeliveryChunkDelivered(turn.id, 0, "response-ts");
  markTurnResponseDelivered(turn.id);
  expect(finishDeliveredTurn(turn.id)).toBeTrue();
  return { turnId: turn.id, directory, deliveries: listTurnArtifactDeliveries(turn.id) };
}

function uploadClient(upload: (args: any) => Promise<any>) {
  return { files: { uploadV2: upload } };
}

describe("durable turn artifact delivery", () => {
  test("persists the exact thread and immutable identity before the turn can finish", () => {
    const created = createDeliveredTurnWithArtifacts(["manifest.json"]);
    const [delivery] = created.deliveries;

    expect(delivery).toMatchObject({
      turn_id: created.turnId,
      slack_channel_id: "C1",
      slack_thread_ts: "100.000001",
      filename: "manifest.json",
      status: "pending",
    });
    expect(delivery.content_sha256).toHaveLength(64);
    expect(listPendingTurnArtifactDeliveries().map((row) => row.artifact_id)).toEqual([
      delivery.artifact_id,
    ]);
  });

  test("retries a known transient Slack failure and removes staging only after confirmation", async () => {
    const created = createDeliveredTurnWithArtifacts(["retry.txt"]);
    const [delivery] = created.deliveries;
    let calls = 0;
    let clock = 1_000;
    const receivedBodies: string[] = [];
    const client = uploadClient(async (args) => {
      calls += 1;
      let body = "";
      for await (const chunk of args.file) body += String(chunk);
      receivedBodies.push(body);
      if (calls === 1) {
        const error: any = new Error("temporary Slack failure");
        error.data = { status: 429, error: "ratelimited", retry_after: 1 };
        throw error;
      }
      return { ok: true, files: [{ id: "F-RETRY" }] };
    });

    const outcome = await scheduleTurnArtifactDelivery(
      client,
      delivery.artifact_id,
      "runtime-current",
      undefined,
      {
        now: () => clock,
        wait: async (milliseconds) => { clock += milliseconds; },
        initialDelayMs: 1,
        maximumDelayMs: 1,
      },
    );

    expect(outcome).toBe("delivered");
    expect(calls).toBe(2);
    expect(receivedBodies).toEqual(["content:retry.txt", "content:retry.txt"]);
    expect(getTurnArtifactDelivery(delivery.artifact_id)).toMatchObject({
      status: "delivered",
      attempts: 2,
      slack_file_id: "F-RETRY",
    });
    expect(existsSync(delivery.source_path)).toBeFalse();
    expect(existsSync(created.directory)).toBeFalse();
  });

  test("parks a permanent failure, exposes it through durable turn status, and retains it for seven days", async () => {
    const created = createDeliveredTurnWithArtifacts(["parked.txt"]);
    const [delivery] = created.deliveries;
    let projectedTurnId: number | null = null;
    const client = uploadClient(async () => ({ ok: false, error: "invalid_auth" }));

    const outcome = await scheduleTurnArtifactDelivery(
      client,
      delivery.artifact_id,
      "runtime-current",
      undefined,
      {
        now: () => 10_000,
        projectFailure: async (turnId) => { projectedTurnId = turnId; },
      },
    );

    expect(outcome).toBe("permanent_failure");
    expect(projectedTurnId).toBe(created.turnId);
    expect(getTurnArtifactDelivery(delivery.artifact_id)).toMatchObject({ status: "parked" });
    expect(getTurnStatusProjection(created.turnId)).toMatchObject({ projection_status: "pending" });
    expect(getTurnStatusProjection(created.turnId)?.desired_text).toContain("Artifact upload for parked.txt was parked");
    expect(existsSync(delivery.source_path)).toBeTrue();
    expect(cleanExpiredArtifactStaging(10_000 + 7 * 24 * 60 * 60 * 1000 - 1)).toBe(0);
    expect(cleanExpiredArtifactStaging(10_000 + 7 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(existsSync(delivery.source_path)).toBeFalse();
  });

  test("never retries a transport error whose Slack acceptance outcome is ambiguous", async () => {
    const created = createDeliveredTurnWithArtifacts(["uncertain.txt"]);
    const [delivery] = created.deliveries;
    let calls = 0;
    const client = uploadClient(async () => {
      calls += 1;
      const error: any = new Error("socket reset after request write");
      error.code = "ECONNRESET";
      throw error;
    });

    const outcome = await scheduleTurnArtifactDelivery(
      client,
      delivery.artifact_id,
      "runtime-current",
      undefined,
      { wait: async () => {} },
    );

    expect(outcome).toBe("permanent_failure");
    expect(calls).toBe(1);
    expect(getTurnArtifactDelivery(delivery.artifact_id)).toMatchObject({ status: "ambiguous", attempts: 1 });
    expect(getTurnArtifactBatch(created.turnId)?.status).toBe("ambiguous");
    expect(getTurnStatusProjection(created.turnId)?.desired_text).toContain("parked as ambiguous");
  });

  test("retention cleanup refuses a parked file modified in place until its full identity matches", async () => {
    const created = createDeliveredTurnWithArtifacts(["retained.txt"]);
    const [delivery] = created.deliveries;
    const client = uploadClient(async () => ({ ok: false, error: "invalid_auth" }));
    await scheduleTurnArtifactDelivery(
      client,
      delivery.artifact_id,
      "runtime-current",
      undefined,
      { now: () => 5_000 },
    );
    const dueAt = 5_000 + 7 * 24 * 60 * 60 * 1000;
    writeFileSync(delivery.source_path, "changed-in-place");

    expect(cleanExpiredArtifactStaging(dueAt)).toBe(0);
    expect(existsSync(delivery.source_path)).toBeTrue();
    writeFileSync(delivery.source_path, "content:retained.txt");
    expect(cleanExpiredArtifactStaging(dueAt)).toBe(1);
    expect(existsSync(delivery.source_path)).toBeFalse();
  });

  test("settles multiple files independently when one succeeds and one permanently fails", async () => {
    const created = createDeliveredTurnWithArtifacts(["good.txt", "bad.txt"]);
    const good = created.deliveries.find((row) => row.filename === "good.txt")!;
    const bad = created.deliveries.find((row) => row.filename === "bad.txt")!;
    const client = uploadClient(async (args) => {
      if (args.filename === "bad.txt") return { ok: false, error: "invalid_auth" };
      for await (const _chunk of args.file) {}
      return { ok: true, files: [{ id: "F-GOOD" }] };
    });

    expect(await scheduleTurnArtifactDelivery(client, good.artifact_id, "runtime-current")).toBe("delivered");
    expect(await scheduleTurnArtifactDelivery(client, bad.artifact_id, "runtime-current")).toBe("permanent_failure");

    expect(getTurnArtifactDelivery(good.artifact_id)?.status).toBe("delivered");
    expect(getTurnArtifactDelivery(bad.artifact_id)?.status).toBe("parked");
    expect(getTurnArtifactBatch(created.turnId)?.status).toBe("parked");
    expect(existsSync(good.source_path)).toBeFalse();
    expect(existsSync(bad.source_path)).toBeTrue();
  });

  test("parks a dead owner's in-flight upload as ambiguous without retrying it", () => {
    const created = createDeliveredTurnWithArtifacts(["ambiguous.txt"]);
    const [delivery] = created.deliveries;
    registerProcessInstance("runtime-dead", 999_999, "old-boot", "1");
    expect(claimTurnArtifactDelivery(delivery.artifact_id, "runtime-dead", 1_000)).not.toBeNull();

    expect(recoverTurnArtifactDeliveryClaims(() => false, 2_000)).toBe(1);

    expect(getTurnArtifactDelivery(delivery.artifact_id)).toMatchObject({
      status: "ambiguous",
      owner_instance_id: null,
    });
    expect(getTurnArtifactBatch(created.turnId)?.status).toBe("ambiguous");
    expect(listPendingTurnArtifactDeliveries()).toEqual([]);
    expect(getTurnStatusProjection(created.turnId)?.desired_text).toContain("outcome is ambiguous");
    expect(existsSync(delivery.source_path)).toBeTrue();
  });
});
