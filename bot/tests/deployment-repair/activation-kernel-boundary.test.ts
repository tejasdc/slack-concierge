import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { currentProcessIdentity } from "../../src/runtime-identity";
import { DeploymentControlStore } from "../../../deployment-control/kernel/state";
import { startKernelServer } from "../../../deployment-control/kernel/server";
import { kernelCommand } from "../../../deployment-control/kernel/protocol";
import { sendKernelCommand } from "../../src/deployment-repair/kernel-client";
import { CoordinatorRuntimeManager } from "../../../deployment-control/kernel/coordinator-runtime";

const rolloutId = "11111111-1111-4111-8111-111111111111";
const ownerUnit = `concierge-deployment-rollout@${rolloutId}.service`;
const invocationId = "22222222222222222222222222222222";
const identityDigest = "a".repeat(64);
const candidateContents = "coordinator candidate\n";
const candidateVersion = createHash("sha256").update(candidateContents).digest("hex");

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
    const runtimeRoot = join(root, "runtime");
    const candidateRoot = join(runtimeRoot, "coordinator", candidateVersion);
    mkdirSync(candidateRoot, { recursive: true });
    writeFileSync(join(candidateRoot, "coordinator.js"), candidateContents);
    writeFileSync(join(candidateRoot, "manifest.json"), JSON.stringify({
      coordinator_bundle_sha256: candidateVersion,
      version: candidateVersion,
    }));
    mkdirSync(join(runtimeRoot, "coordinator/slots"), { recursive: true });
    symlinkSync(`../${candidateVersion}`, join(runtimeRoot, "coordinator/slots/a"));
    let candidateActive = false;
    const coordinatorRuntime = new CoordinatorRuntimeManager({
      runtimeRoot,
      activeRecordPath: join(root, "coordinator-active.json"),
      systemctlBin: "/unused/systemctl",
      run: (args) => {
        if (args[0] === "start") candidateActive = true;
        if (args[0] === "stop") candidateActive = false;
        if (args[0] === "show") {
          return {
            exitCode: 0,
            stdout: `InvocationID=${candidateActive ? invocationId : ""}\nMainPID=${candidateActive ? processIdentity.pid : 0}\nActiveState=${candidateActive ? "active" : "inactive"}\n`,
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
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
        coordinatorRuntime,
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
    expect(mismatchedOwner.error).toContain("does not match the authenticated Unix peer and invocation");

    const claimed = await send("rollout", "rollout.claim",
      { entity: "rollout", id: rolloutId, status: "staged" },
      { rollout_id: rolloutId, owner });
    expect(claimed.result.rollout.owner_invocation_id).toBe(invocationId);

    const replayedFence = await send("rollout", "rollout.heartbeat",
      { entity: "rollout", id: rolloutId, status: "staged" },
      { rollout_id: rolloutId, owner: { ...owner, pid: Number(owner.pid) + 1 } });
    expect(replayedFence.error).toContain("does not match claimed owner PID");

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
        request_id: "missing",
        owner,
        reviewer_session_uuid: "review-session",
        verdict: { verdict: "ship" },
      });
    expect(ownerReview.error).toContain("Caller role rollout cannot execute rollout.review.record");

    const preparedReview = await send("rollout", "rollout.review.prepare",
      { entity: "rollout", id: rolloutId, status: "review_pending" },
      {
        rollout_id: rolloutId,
        review_kind: "implementation",
        owner,
      });
    const reviewRequest = preparedReview.result.review_request;
    const premature = await send("review", "rollout.review.record",
      { entity: "rollout_review", id: reviewRequest.id, status: "prepared" },
      {
        request_id: reviewRequest.id,
        owner,
        reviewer_session_uuid: "review-session",
        verdict: { verdict: "ship" },
      });
    expect(premature.error).toContain("owner lease does not match");
    const claimedReview = await send("review", "rollout.review.claim",
      { entity: "rollout_review", id: reviewRequest.id, status: "prepared" },
      { request_id: reviewRequest.id, owner });
    expect(claimedReview.result.review_request.status).toBe("running");
    await send("review", "rollout.review.provider_admit",
      { entity: "rollout_review", id: reviewRequest.id, status: "running" },
      { request_id: reviewRequest.id, owner });
    await send("review", "rollout.review.bind_session",
      { entity: "rollout_review", id: reviewRequest.id, status: "running" },
      { request_id: reviewRequest.id, owner, reviewer_session_uuid: "review-session" });
    const reviewed = await send("review", "rollout.review.record",
      { entity: "rollout_review", id: reviewRequest.id, status: "running" },
      {
        request_id: reviewRequest.id,
        owner,
        reviewer_session_uuid: "review-session",
        verdict: { verdict: "ship" },
      });
    expect(reviewed.error).toBeUndefined();
    expect(reviewed.result.review).toMatchObject({ review_kind: "implementation", status: "ship" });

    const prepared = await send("rollout", "activation.prepare",
      { entity: "rollout", id: rolloutId, status: "authorized" },
      {
        rollout_id: rolloutId,
        owner,
        kind: "canary",
        candidate_slot: "a",
        candidate_version: candidateVersion,
      });
    const generation = prepared.result.activation;
    const started = await send("rollout", "coordinator.candidate.start",
      { entity: "activation", id: generation.id, status: "pending" },
      { rollout_id: rolloutId, generation_id: generation.id, owner });
    expect(started.result.candidate.active).toBeTrue();
    const earlyExposure = await send("rollout", "activation.expose",
      { entity: "activation", id: generation.id, status: "pending" },
      { rollout_id: rolloutId, generation_id: generation.id, owner });
    expect(earlyExposure.error).toContain("requires bot and coordinator acknowledgments");

    for (const role of ["bot", "coordinator"] as const) {
      const acknowledged = await send(role, "activation.ack",
        { entity: "activation", id: generation.id, status: "pending" },
        {
          generation_id: generation.id,
          identity_digest: identityDigest,
          ...(role === "coordinator" ? {
            coordinator_owner: {
              ...owner,
              slot: "a",
              version: candidateVersion,
            },
          } : {}),
        });
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
