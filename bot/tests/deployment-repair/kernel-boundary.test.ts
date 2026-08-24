import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { DeploymentControlStore } from "../../../deployment-control/kernel/state";
import { startKernelServer } from "../../../deployment-control/kernel/server";
import { kernelCommand } from "../../../deployment-control/kernel/protocol";
import {
  DeterministicSlackNotifier,
  notificationClientMessageId,
  notificationDigest,
} from "../../../deployment-control/kernel/notifier";
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
  let sockets: Record<"bot" | "coordinator" | "runner" | "operator", string>;
  let slackCalls: Array<{ method: string; body: any }>;
  let activationGenerationId: string;

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
    const rolloutId = "11111111-1111-4111-8111-111111111111";
    const identityDigest = "9".repeat(64);
    const rolloutOwner = {
      invocationId: "22222222222222222222222222222222",
      pid: 4242,
      bootId: "33333333-3333-4333-8333-333333333333",
      startTicks: "123456",
      identityDigest,
    };
    store.createRollout({
      id: rolloutId,
      ownerUnit: `concierge-deployment-rollout@${rolloutId}.service`,
      identityDigest,
      nextStep: "claim",
    });
    store.claimRolloutLease({
      rolloutId,
      ownerUnit: `concierge-deployment-rollout@${rolloutId}.service`,
      ...rolloutOwner,
    });
    for (const [expectedStatus, status] of [
      ["staged", "containing_application"],
      ["containing_application", "staging_coordinator"],
      ["staging_coordinator", "proving"],
      ["proving", "review_pending"],
    ] as const) {
      store.transitionRollout({ rolloutId, expectedStatus, status, nextStep: status, ...rolloutOwner });
    }
    store.recordRolloutReview({
      rolloutId,
      reviewKind: "implementation",
      verdict: "ship",
      reviewedDigest: identityDigest,
      identityDigest,
      reviewerSessionUuid: "implementation-review",
      verdictPayload: { verdict: "ship" },
    });
    const canary = store.prepareActivationGeneration({ rolloutId, kind: "canary", ...rolloutOwner });
    store.acknowledgeActivation({ generationId: canary.id, role: "bot", identityDigest });
    store.acknowledgeActivation({ generationId: canary.id, role: "coordinator", identityDigest });
    store.exposeActivationGeneration({ rolloutId, generationId: canary.id, ...rolloutOwner });
    store.revokeActivationGeneration({ rolloutId, generationId: canary.id, reason: "test proof", ...rolloutOwner });
    store.recordRolloutCheck({
      rolloutId,
      name: "test_recovery",
      phase: "recovery",
      status: "passed",
      evidenceDigest: "8".repeat(64),
      evidence: { passed: true },
      ...rolloutOwner,
    });
    const frozen = store.freezeRolloutEvidence({ rolloutId, ...rolloutOwner });
    store.recordRolloutReview({
      rolloutId,
      reviewKind: "live_evidence",
      verdict: "ship",
      reviewedDigest: frozen.evidence_digest!,
      identityDigest,
      reviewerSessionUuid: "evidence-review",
      verdictPayload: { verdict: "ship" },
    });
    const production = store.prepareActivationGeneration({ rolloutId, kind: "production", ...rolloutOwner });
    store.acknowledgeActivation({ generationId: production.id, role: "bot", identityDigest });
    store.acknowledgeActivation({ generationId: production.id, role: "coordinator", identityDigest });
    store.exposeActivationGeneration({ rolloutId, generationId: production.id, ...rolloutOwner });
    store.verifyProductionRollout({ rolloutId, generationId: production.id, ...rolloutOwner });
    activationGenerationId = production.id;
    const applicationStatePath = join(fixtureRoot, "application.db");
    const application = new Database(applicationStatePath, { create: true });
    application.exec(`CREATE TABLE channels (
      slack_channel_id TEXT, slack_channel_name TEXT NOT NULL, code_path TEXT
    )`);
    application.query("INSERT INTO channels VALUES (?, ?, ?)")
      .run("C-project", "slack-concierge", repositoryRoot);
    application.close();
    const slackConfigPath = join(fixtureRoot, "slack.toml");
    writeFileSync(slackConfigPath, `bot_token = "${["xoxb", "fixture-token"].join("-")}"\n`);
    slackCalls = [];
    let lastText = "";
    const notifier = new DeterministicSlackNotifier(slackConfigPath, {
      now: () => new Date("2026-08-24T00:01:00Z"),
      async fetch(url, init) {
        const method = url.split("/").at(-1)!;
        const body = JSON.parse(String(init.body));
        slackCalls.push({ method, body });
        if (method === "auth.test") return new Response(JSON.stringify({ ok: true, user_id: "U-bot" }));
        if (method === "chat.postMessage") {
          lastText = body.text;
          return new Response(JSON.stringify({ ok: true, ts: `1700000000.00000${slackCalls.length}` }));
        }
        if (method === "conversations.history") {
          return new Response(JSON.stringify({
            ok: true,
            messages: [{ ts: body.oldest, user: "U-bot", text: lastText }],
          }));
        }
        if (method === "chat.delete") return new Response(JSON.stringify({ ok: true }));
        throw new Error(`Unexpected Slack method ${method}`);
      },
    });
    sockets = {
      bot: join(fixtureRoot, "bot.sock"),
      coordinator: join(fixtureRoot, "coordinator.sock"),
      runner: join(fixtureRoot, "runner.sock"),
      operator: join(fixtureRoot, "operator.sock"),
    };
    server = startKernelServer({
      store,
      environment: {
        repositoryRoot: repository,
        policyPath: join(repositoryRoot, "config/deployment-repair-policy.toml"),
        kernelRoot: join(repositoryRoot, "deployment-control/kernel"),
        originRemote: "origin",
        originBranch: "main",
        deployScript: join(repositoryRoot, "bot/scripts/deploy.sh"),
        systemdRunBin: "/usr/bin/systemd-run",
        systemctlBin: "/usr/bin/systemctl",
        home: "/root",
        drainIntervalSeconds: "0",
        releaseManager: {
          prepare: (_attemptId: string, gitCommit: string) => ({
            gitCommit,
            artifactPath: join(fixtureRoot, "releases", "a".repeat(64)),
            artifactDigest: "a".repeat(64),
            runtimeDigest: "b".repeat(64),
            compatibilityDigest: "c".repeat(64),
            sourceTreeDigest: "d".repeat(64),
            builderUnit: "builder-fixture",
          }),
          activate: () => ({
            git_commit: commit,
            artifact_digest: "a".repeat(64),
            service_invocation_id: "e".repeat(32),
          }),
        } as any,
        notifier,
        applicationStatePath,
        slackConfigPath,
        identityManifest: () => ({
          digest: identityDigest,
          manifest: { schema_version: 1, files: [], effective_units: [] },
        }),
      },
      configureOwnership: false,
      sockets: [
        { role: "bot", path: sockets.bot, mode: 0o600 },
        { role: "coordinator", path: sockets.coordinator, mode: 0o600 },
        { role: "runner", path: sockets.runner, mode: 0o600 },
        { role: "operator", path: sockets.operator, mode: 0o600 },
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

  test("operator control commands do not require the bot application database", async () => {
    const environment = {
      ...process.env,
      CONCIERGE_DEPLOYMENT_SOCKET_DIR: fixtureRoot,
    };
    delete environment.CONCIERGE_STATE_DIR;
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(repositoryRoot, "bot/scripts/deployment-repair/control.ts"),
        "snapshot",
        "--role",
        "operator",
      ],
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      target: "concierge",
      kernel_runtime_version: expect.any(String),
    });
  });

  test("origin-proven intent admission and idempotent replay preserve one intent", async () => {
    const command = kernelCommand(
      "intent.request",
      { entity: "target", id: "concierge", status: "ready" },
      {
        activation_generation_id: activationGenerationId,
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
        activation_generation_id: activationGenerationId,
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
      { activation_generation_id: activationGenerationId },
    ), { socketPath: sockets.coordinator });
    expect(generationResponse.ok).toBeTrue();
    const generation = generationResponse.result.generation;

    const stale = await sendKernelCommand("coordinator", kernelCommand(
      "generation.prepare",
      { entity: "target", id: "concierge", status: "idle" },
      { activation_generation_id: activationGenerationId },
    ), { socketPath: sockets.coordinator });
    expect(stale).toMatchObject({ ok: false });
    expect(stale.error).toContain("found active");

    const attemptResponse = await sendKernelCommand("coordinator", kernelCommand(
      "attempt.create",
      { entity: "generation", id: generation.id, status: "prepared" },
      { generation_id: generation.id, activation_generation_id: activationGenerationId },
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

  test("operator-only notifier derives its immutable channel and rejects text overrides", async () => {
    const unauthorized = await sendKernelCommand("bot", kernelCommand(
      "notifier.target.bootstrap",
      { entity: "target", id: "concierge", status: "ready" },
      { registry_code_path: repositoryRoot },
    ), { socketPath: sockets.bot });
    expect(unauthorized.error).toContain("Caller role bot cannot execute");

    const bootstrapped = await sendKernelCommand("operator", kernelCommand(
      "notifier.target.bootstrap",
      { entity: "target", id: "concierge", status: "ready" },
      { registry_code_path: repositoryRoot },
    ), { socketPath: sockets.operator });
    expect(bootstrapped.result.target.slack_channel_id).toBe("C-project");
    const preflight = await sendKernelCommand("operator", kernelCommand(
      "notifier.preflight",
      { entity: "target", id: "concierge", status: "ready" },
      {},
    ), { socketPath: sockets.operator });
    expect(preflight.ok).toBeTrue();

    const intent = store.requestIntent({
      expectedCommit: commit,
      continuation: {
        sourceTurnId: 50,
        sourceSessionId: 51,
        slackChannelId: "C-project",
        slackThreadTs: "1700000000.000001",
        requestedByUserId: null,
        providerId: "codex",
        providerModel: null,
        reasoningEffort: null,
        providerSessionUuid: "provider-session-50",
      },
    });
    const generation = store.prepareGeneration({
      desiredCommit: commit,
      originUrl: origin,
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const attempt = store.createAttempt(generation.id);
    const failed = store.failAttempt({
      attemptId: attempt.id,
      outcome: "failed",
      error: "candidate unhealthy",
      failureFingerprint: "health:candidate",
    });
    const incident = store.transitionIncident(failed.incident!.id, "stabilizing");
    const projection = {
      incident_id: incident.id,
      candidate_commit: commit,
      restored_commit: commit,
      service_invocation_id: "a".repeat(32),
      capture_probe: "functional health passed",
      service_probe: "functional health passed",
      admission_state: "released",
      reason_code: "candidate_health_failed",
    };
    const preparedAfterCrash = store.prepareNotification({
      incidentId: incident.id,
      kind: "runtime_restored",
      payload: projection,
      payloadDigest: notificationDigest("runtime_restored", projection),
      clientMessageId: notificationClientMessageId(incident.id, "runtime_restored"),
    });
    const resumed = await sendKernelCommand("coordinator", kernelCommand(
      "notification.reconcile",
      { entity: "notification", id: preparedAfterCrash.id, status: "prepared" },
      { notification_id: preparedAfterCrash.id, activation_generation_id: activationGenerationId },
    ), { socketPath: sockets.coordinator });
    expect(resumed.result.notification.status).toBe("delivered");
    const postsAfterResume = slackCalls.filter((call) => call.method === "chat.postMessage").length;

    const sent = await sendKernelCommand("operator", kernelCommand(
      "notification.send",
      { entity: "incident", id: incident.id, status: "stabilizing" },
      { incident_id: incident.id, kind: "runtime_restored", projection },
    ), { socketPath: sockets.operator });
    expect(sent.result.notification.status).toBe("delivered");
    expect(slackCalls.filter((call) => call.method === "chat.postMessage")).toHaveLength(postsAfterResume);
    expect(slackCalls.at(-1)!.body.channel).toBe("C-project");

    const overridden = await sendKernelCommand("operator", kernelCommand(
      "notification.send",
      { entity: "incident", id: incident.id, status: "stabilizing" },
      { incident_id: incident.id, kind: "runtime_restored", projection: { ...projection, text: "<@channel>" } },
    ), { socketPath: sockets.operator });
    expect(overridden.ok).toBeFalse();
    expect(overridden.error).toContain("fields are invalid");
  });

  test("operator bootstrap binds a clean origin release and promotes only exact health evidence", async () => {
    const prepared = await sendKernelCommand("operator", kernelCommand(
      "release.bootstrap_prepare",
      { entity: "target", id: "concierge", status: "ready" },
      {},
    ), { socketPath: sockets.operator });
    expect(prepared.ok).toBeTrue();
    expect(prepared.result.release).toMatchObject({ git_commit: commit, status: "candidate" });
    const release = prepared.result.release;

    const activated = await sendKernelCommand("operator", kernelCommand(
      "release.bootstrap_activate",
      { entity: "release", id: release.id, status: "candidate" },
      { release_id: release.id },
    ), { socketPath: sockets.operator });
    expect(activated.result.activation.service_invocation_id).toBe("e".repeat(32));

    const rejected = await sendKernelCommand("operator", kernelCommand(
      "release.bootstrap_promote",
      { entity: "release", id: release.id, status: "candidate" },
      {
        release_id: release.id,
        service_invocation_id: "e".repeat(32),
        evidence: {
          runtime_sha: "f".repeat(40),
          service_invocation_id: "e".repeat(32),
          capture_probe: "functional health passed",
          service_probe: "functional health passed",
          admission_gates: "released",
        },
      },
    ), { socketPath: sockets.operator });
    expect(rejected.ok).toBeFalse();

    const promoted = await sendKernelCommand("operator", kernelCommand(
      "release.bootstrap_promote",
      { entity: "release", id: release.id, status: "candidate" },
      {
        release_id: release.id,
        service_invocation_id: "e".repeat(32),
        evidence: {
          runtime_sha: commit,
          service_invocation_id: "e".repeat(32),
          capture_probe: "functional health passed",
          service_probe: "functional health passed",
          admission_gates: "released",
        },
      },
    ), { socketPath: sockets.operator });
    expect(promoted.result.release.status).toBe("last_known_good");
  });
});
