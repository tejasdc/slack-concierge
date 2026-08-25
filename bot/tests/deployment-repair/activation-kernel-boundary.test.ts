import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { currentProcessIdentity } from "../../src/runtime-identity";
import { DeploymentControlStore } from "../../../deployment-control/kernel/state";
import { startKernelServer } from "../../../deployment-control/kernel/server";
import { kernelCommand } from "../../../deployment-control/kernel/protocol";
import { sendKernelCommand } from "../../src/deployment-repair/kernel-client";

const rolloutId = "11111111-1111-4111-8111-111111111111";
const ownerUnit = `concierge-deployment-rollout@${rolloutId}.service`;
const invocationId = "22222222222222222222222222222222";
const identityDigest = "a".repeat(64);

describe("activation kernel role boundary", () => {
  let root: string;
  let store: DeploymentControlStore;
  let server: ReturnType<typeof startKernelServer>;
  let sockets: Record<"bot" | "coordinator" | "review" | "rollout", string>;
  let owner: Record<string, unknown>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "concierge-activation-kernel-"));
    store = new DeploymentControlStore(":memory:");
    sockets = {
      bot: join(root, "bot.sock"),
      coordinator: join(root, "coordinator.sock"),
      review: join(root, "review.sock"),
      rollout: join(root, "rollout.sock"),
    };
    const processIdentity = currentProcessIdentity();
    owner = {
      invocation_id: invocationId,
      pid: processIdentity.pid,
      boot_id: processIdentity.bootId,
      start_ticks: processIdentity.startTicks,
    };
    server = startKernelServer({
      store,
      configureOwnership: false,
      sockets: [
        { role: "bot", path: sockets.bot, mode: 0o600 },
        { role: "coordinator", path: sockets.coordinator, mode: 0o600 },
        { role: "review", path: sockets.review, mode: 0o600 },
        { role: "rollout", path: sockets.rollout, mode: 0o600 },
      ],
      environment: {
        repositoryRoot: root,
        policyPath: join(import.meta.dir, "../../../config/deployment-repair-policy.toml"),
        kernelRoot: join(import.meta.dir, "../../../deployment-control/kernel"),
        originRemote: "origin",
        originBranch: "main",
        deployScript: "/unused/deploy.sh",
        systemdRunBin: "/usr/bin/systemd-run",
        systemctlBin: "/usr/bin/systemctl",
        home: "/root",
        drainIntervalSeconds: "0",
        applicationStatePath: join(root, "application.db"),
        slackConfigPath: join(root, "slack.toml"),
        identityManifest: () => ({
          digest: identityDigest,
          manifest: { schema_version: 1, files: [], effective_units: [] },
        }),
        rolloutUnitIdentity: () => ({
          invocationId,
          mainPid: processIdentity.pid,
          active: true,
        }),
      },
    });
  });

  afterEach(() => {
    server.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function send(role: keyof typeof sockets, command: string, expected: any, payload: Record<string, unknown>) {
    return sendKernelCommand(role, kernelCommand(command, expected, payload), { socketPath: sockets[role] });
  }

  test("only the fenced rollout and review roles can create activation authority", async () => {
    const unauthorized = await send("bot", "rollout.create",
      { entity: "target", id: "concierge", status: "ready" },
      { rollout_id: rolloutId, owner_unit: ownerUnit });
    expect(unauthorized.error).toContain("Caller role bot cannot execute rollout.create");

    const created = await send("rollout", "rollout.create",
      { entity: "target", id: "concierge", status: "ready" },
      { rollout_id: rolloutId, owner_unit: ownerUnit });
    expect(created.result.rollout).toMatchObject({ status: "staged", identity_digest: identityDigest });

    const mismatchedOwner = await send("rollout", "rollout.claim",
      { entity: "rollout", id: rolloutId, status: "staged" },
      { rollout_id: rolloutId, owner: { ...owner, invocation_id: "wrong" } });
    expect(mismatchedOwner.error).toContain("does not match the claimed invocation and PID");

    const claimed = await send("rollout", "rollout.claim",
      { entity: "rollout", id: rolloutId, status: "staged" },
      { rollout_id: rolloutId, owner });
    expect(claimed.result.rollout.owner_invocation_id).toBe(invocationId);

    for (const [from, to] of [
      ["staged", "containing_application"],
      ["containing_application", "staging_coordinator"],
      ["staging_coordinator", "proving"],
      ["proving", "review_pending"],
    ]) {
      const transitioned = await send("rollout", "rollout.transition",
        { entity: "rollout", id: rolloutId, status: from },
        { rollout_id: rolloutId, owner, status: to, next_step: `run_${to}` });
      expect(transitioned.ok).toBeTrue();
    }

    const ownerReview = await send("rollout", "rollout.review.record",
      { entity: "rollout", id: rolloutId, status: "review_pending" },
      {
        rollout_id: rolloutId,
        review_kind: "implementation",
        reviewed_digest: identityDigest,
        reviewer_session_uuid: "review-session",
        verdict: { verdict: "ship" },
      });
    expect(ownerReview.error).toContain("Caller role rollout cannot execute rollout.review.record");

    const reviewed = await send("review", "rollout.review.record",
      { entity: "rollout", id: rolloutId, status: "review_pending" },
      {
        rollout_id: rolloutId,
        review_kind: "implementation",
        reviewed_digest: identityDigest,
        reviewer_session_uuid: "review-session",
        verdict: { verdict: "ship" },
      });
    expect(reviewed.result.review).toMatchObject({ review_kind: "implementation", status: "ship" });

    const prepared = await send("rollout", "activation.prepare",
      { entity: "rollout", id: rolloutId, status: "authorized" },
      { rollout_id: rolloutId, owner, kind: "canary" });
    const generation = prepared.result.activation;
    const earlyExposure = await send("rollout", "activation.expose",
      { entity: "activation", id: generation.id, status: "pending" },
      { rollout_id: rolloutId, generation_id: generation.id, owner });
    expect(earlyExposure.error).toContain("requires bot and coordinator acknowledgments");

    for (const role of ["bot", "coordinator"] as const) {
      const acknowledged = await send(role, "activation.ack",
        { entity: "activation", id: generation.id, status: "pending" },
        { generation_id: generation.id, identity_digest: identityDigest });
      expect(acknowledged.ok).toBeTrue();
    }
    const exposed = await send("rollout", "activation.expose",
      { entity: "activation", id: generation.id, status: "pending" },
      { rollout_id: rolloutId, generation_id: generation.id, owner });
    expect(exposed.result.activation).toMatchObject({ kind: "canary", status: "exposed" });

    const ordinaryIntent = await send("bot", "intent.request",
      { entity: "target", id: "concierge", status: "ready" },
      { activation_generation_id: generation.id });
    expect(ordinaryIntent.error).toContain("exposed production activation generation is required");
  });
});
