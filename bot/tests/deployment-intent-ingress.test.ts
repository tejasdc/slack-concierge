import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEPLOYMENT_INTENT_PROTOCOL_VERSION,
  DeploymentIntentIngress,
  assertDeploymentIntentRequest,
  deploymentIntentSocketPath,
  requestDeploymentIntent,
} from "../src/deployment-intent-ingress";

const scratch: string[] = [];
const ingresses: DeploymentIntentIngress[] = [];

afterEach(async () => {
  await Promise.allSettled(ingresses.splice(0).map((ingress) => ingress.stop()));
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectScratch() {
  const root = mkdtempSync(join(tmpdir(), "concierge-deployment-intent-"));
  scratch.push(root);
  const project = join(root, "project-a");
  mkdirSync(project, { mode: 0o3770 });
  chmodSync(project, 0o3770);
  return project;
}

function environment(socketPath: string) {
  return {
    CONCIERGE_DEPLOYMENT_INTENT_SOCKET: socketPath,
    CONCIERGE_TURN_ID: "42",
    CONCIERGE_OWNER_INSTANCE_ID: "owner-42",
    CONCIERGE_SESSION_ID: "7",
    CONCIERGE_SLACK_CHANNEL_ID: "C1",
    CONCIERGE_SLACK_THREAD_TS: "100.000001",
  };
}

describe("contained deployment intent ingress", () => {
  test("accepts one bounded typed request through only the assigned project socket", async () => {
    const scratchPath = projectScratch();
    const project = {
      id: "project-a",
      stable_path: "/srv/projects/a",
      scratch_path: scratchPath,
    };
    const received: any[] = [];
    const ingress = new DeploymentIntentIngress([project], async (observedProject, request) => {
      received.push({ observedProject, request });
      return { status: "requested", intent: { id: "intent-1" } };
    });
    ingresses.push(ingress);
    await ingress.start();
    const socketPath = deploymentIntentSocketPath(scratchPath);

    const result = await requestDeploymentIntent({
      expectedCommit: "a".repeat(40),
      socketPath,
      environment: environment(socketPath),
    });

    expect(result).toEqual({ status: "requested", intent: { id: "intent-1" } });
    expect(received).toHaveLength(1);
    expect(received[0].observedProject.id).toBe("project-a");
    expect(received[0].request).toMatchObject({
      protocol_version: DEPLOYMENT_INTENT_PROTOCOL_VERSION,
      expected_commit: "a".repeat(40),
      context: {
        source_turn_id: 42,
        owner_instance_id: "owner-42",
        source_session_id: 7,
        slack_channel_id: "C1",
        slack_thread_ts: "100.000001",
      },
    });
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o660);
    expect(lstatSync(join(scratchPath, "deployment-intent")).mode & 0o7777).toBe(0o750);
    expect(lstatSync(socketPath).gid).toBe(lstatSync(join(scratchPath, "deployment-intent")).gid);
  });

  test("rejects malformed context and caller-added authority fields", () => {
    const valid = {
      protocol_version: DEPLOYMENT_INTENT_PROTOCOL_VERSION,
      id: "deployment:request-1",
      expected_commit: "b".repeat(40),
      context: {
        source_turn_id: 1,
        owner_instance_id: "owner-1",
        source_session_id: 2,
        slack_channel_id: "C1",
        slack_thread_ts: "200.000001",
      },
    };
    expect(() => assertDeploymentIntentRequest({ ...valid, project_id: "project-b" }))
      .toThrow("forbidden fields");
    expect(() => assertDeploymentIntentRequest({
      ...valid,
      context: { ...valid.context, source_turn_id: 0 },
    })).toThrow("invalid");
  });

  test("an oversized peer is disconnected without taking down the project listener", async () => {
    const scratchPath = projectScratch();
    const ingress = new DeploymentIntentIngress([{
      id: "project-a",
      stable_path: "/srv/projects/a",
      scratch_path: scratchPath,
    }], async () => ({ status: "requested" }));
    ingresses.push(ingress);
    await ingress.start();
    const socketPath = deploymentIntentSocketPath(scratchPath);
    const oversized = createConnection(socketPath);
    await once(oversized, "connect");
    oversized.write("x".repeat(65 * 1024));
    await once(oversized, "close");

    await expect(requestDeploymentIntent({
      expectedCommit: "c".repeat(40),
      socketPath,
      environment: environment(socketPath),
    })).resolves.toEqual({ status: "requested" });
  });

  test("shutdown cannot be held open by an idle provider connection", async () => {
    const scratchPath = projectScratch();
    const ingress = new DeploymentIntentIngress([{
      id: "project-a",
      stable_path: "/srv/projects/a",
      scratch_path: scratchPath,
    }], async () => ({ status: "requested" }));
    ingresses.push(ingress);
    await ingress.start();
    const socket = createConnection(deploymentIntentSocketPath(scratchPath));
    await once(socket, "connect");

    await expect(Promise.race([
      ingress.stop().then(() => "stopped"),
      Bun.sleep(250).then(() => "timed-out"),
    ])).resolves.toBe("stopped");
  });
});
