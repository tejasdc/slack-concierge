import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeploymentControlStore } from "../../../deployment-control/kernel/state";
import { startKernelServer } from "../../../deployment-control/kernel/server";
import { kernelCommand } from "../../../deployment-control/kernel/protocol";
import { sendKernelCommand } from "../../src/deployment-repair/kernel-client";

const repositoryRoot = join(import.meta.dir, "../../..");

function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", "-C", directory, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe("protected deployment kernel boundary", () => {
  let fixtureRoot: string;
  let origin: string;
  let repository: string;
  let commit: string;
  let store: DeploymentControlStore;
  let server: ReturnType<typeof startKernelServer>;
  let sockets: Record<"bot" | "coordinator" | "runner", string>;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "concierge-kernel-"));
    origin = join(fixtureRoot, "origin.git");
    repository = join(fixtureRoot, "repo");
    Bun.spawnSync({ cmd: ["git", "init", "--bare", "--initial-branch=main", origin] });
    Bun.spawnSync({ cmd: ["git", "init", "--initial-branch=main", repository] });
    git(repository, "config", "user.name", "Kernel Test");
    git(repository, "config", "user.email", "kernel@example.invalid");
    writeFileSync(join(repository, "README.md"), "fixture\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "fixture");
    commit = git(repository, "rev-parse", "HEAD");
    git(repository, "remote", "add", "origin", origin);
    git(repository, "push", "-u", "origin", "main");

    store = new DeploymentControlStore(":memory:");
    sockets = {
      bot: join(fixtureRoot, "bot.sock"),
      coordinator: join(fixtureRoot, "coordinator.sock"),
      runner: join(fixtureRoot, "runner.sock"),
    };
    server = startKernelServer({
      store,
      environment: {
        repositoryRoot: repository,
        policyPath: join(repositoryRoot, "config/deployment-repair-policy.toml"),
        kernelRoot: join(repositoryRoot, "deployment-control/kernel"),
        originRemote: "origin",
        originBranch: "main",
      },
      configureOwnership: false,
      sockets: [
        { role: "bot", path: sockets.bot, mode: 0o600 },
        { role: "coordinator", path: sockets.coordinator, mode: 0o600 },
        { role: "runner", path: sockets.runner, mode: 0o600 },
      ],
    });
  });

  afterEach(() => {
    server.stop();
    store.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("socket identity fixes the caller role and rejects cross-role commands", async () => {
    const response = await sendKernelCommand("bot", kernelCommand(
      "attempt.fail",
      { entity: "attempt", id: "missing", status: "updating" },
      {
        attempt_id: "missing",
        outcome: "failed",
        error: "should not run",
        failure_fingerprint: "test:unauthorized",
      },
    ), { socketPath: sockets.bot });
    expect(response).toEqual({ ok: false, error: "Caller role bot cannot execute attempt.fail." });
    expect(store.database.query("SELECT count(*) AS count FROM deployment_commands").get())
      .toEqual({ count: 0 });
  });

  test("origin-proven intent admission and idempotent replay preserve one intent", async () => {
    const command = kernelCommand(
      "intent.request",
      { entity: "target", id: "concierge", status: "ready" },
      {
        expected_commit: commit,
        continuation: {
          source_turn_id: 1,
          source_session_id: 2,
          slack_channel_id: "C-project",
          slack_thread_ts: "1700000000.000001",
          requested_by_user_id: "U-operator",
          provider_id: "codex",
          provider_model: "gpt-5.6",
          reasoning_effort: "high",
          provider_session_uuid: "provider-session",
        },
      },
      "kernel:intent.request:stable-replay",
    );
    const first = await sendKernelCommand("bot", command, { socketPath: sockets.bot });
    const replay = await sendKernelCommand("bot", command, { socketPath: sockets.bot });
    expect(first.error).toBeUndefined();
    expect(first.ok).toBeTrue();
    expect(replay).toEqual(first);
    expect(store.listIntents("concierge")).toHaveLength(1);

    const changed = structuredClone(command);
    changed.payload.expected_commit = "f".repeat(40);
    const conflict = await sendKernelCommand("bot", changed, { socketPath: sockets.bot });
    expect(conflict.ok).toBeFalse();
    expect(conflict.error).toContain("reused for a different command");
  });

  test("expected-state fencing rejects stale coordinator and runner commands", async () => {
    const intentResponse = await sendKernelCommand("bot", kernelCommand(
      "intent.request",
      { entity: "target", id: "concierge", status: "ready" },
      {
        expected_commit: commit,
        continuation: {
          source_turn_id: 1,
          source_session_id: 2,
          slack_channel_id: "C-project",
          slack_thread_ts: "1700000000.000001",
          requested_by_user_id: null,
          provider_id: "codex",
          provider_model: null,
          reasoning_effort: null,
          provider_session_uuid: "provider-session",
        },
      },
    ), { socketPath: sockets.bot });
    expect(intentResponse.error).toBeUndefined();
    expect(intentResponse.ok).toBeTrue();

    const generationResponse = await sendKernelCommand("coordinator", kernelCommand(
      "generation.prepare",
      { entity: "target", id: "concierge", status: "idle" },
      {},
    ), { socketPath: sockets.coordinator });
    expect(generationResponse.ok).toBeTrue();
    const generation = generationResponse.result.generation;

    const stale = await sendKernelCommand("coordinator", kernelCommand(
      "generation.prepare",
      { entity: "target", id: "concierge", status: "idle" },
      {},
    ), { socketPath: sockets.coordinator });
    expect(stale).toMatchObject({ ok: false });
    expect(stale.error).toContain("found active");

    const attemptResponse = await sendKernelCommand("coordinator", kernelCommand(
      "attempt.create",
      { entity: "generation", id: generation.id, status: "prepared" },
      { generation_id: generation.id },
    ), { socketPath: sockets.coordinator });
    expect(attemptResponse.ok).toBeTrue();
    const attempt = attemptResponse.result.attempt;

    const skipped = await sendKernelCommand("runner", kernelCommand(
      "attempt.phase",
      { entity: "attempt", id: attempt.id, status: "prepared" },
      { attempt_id: attempt.id, phase: "updating" },
    ), { socketPath: sockets.runner });
    expect(skipped.ok).toBeFalse();
    expect(skipped.error).toContain("cannot transition prepared -> updating");

    const identitySwap = await sendKernelCommand("runner", kernelCommand(
      "attempt.phase",
      { entity: "attempt", id: attempt.id, status: "prepared" },
      { attempt_id: "different-attempt-id", phase: "updating" },
    ), { socketPath: sockets.runner });
    expect(identitySwap.ok).toBeFalse();
    expect(identitySwap.error).toContain("payload identity does not match");
  });
});
