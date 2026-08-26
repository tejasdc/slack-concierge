import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../src/providers";
import { slackBucket } from "../src/rate-limit";
import { TurnSteeringController } from "../src/steering";
import { CONCIERGE_SESSION_RESPONSE_CONTRACT } from "../src/response-contract";
import { SessionTurnQueueCoordinator } from "../src/session-turn-queue";
import { ActiveTurnDispatchRegistry, TurnCancellationController } from "../src/turn-dispatch-seams";
import { ProviderTurnCancelledError } from "../src/provider-failures";
import { executeAgentTurn, type TurnExecutionServices } from "../src/turn-execution";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  beginTurnProgressStream,
  claimSlackThreadStatusProjection,
  claimNextQueuedTurn,
  claimTurnStatusProjection,
  createOrGetSession,
  db,
  getChannel,
  getTurnArtifactBatch,
  getSession,
  getSlackThreadStatus,
  getTurnStatusProjection,
  listRecoverableTurns,
  markDeliveryChunkDelivered,
  markSlackThreadStatusProjectionDelivered,
  markTurnStatusProjectionDelivered,
  recordTurnStatusMessage,
  recordTurnProgressStreamStarted,
  requestSlackThreadStatusProjection,
  requestTurnStatusProjection,
  upsertChannel,
  upsertSession,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
let projectDir = "";

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM slack_root_summary_projections").run();
  db.query("DELETE FROM slack_thread_statuses").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
  slackBucket.reset();
  projectDir = mkdtempSync(join(tmpdir(), "concierge-turn-execution-"));
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

async function projectTurnStatus(client: any, turnId: number, text: string) {
  requestTurnStatusProjection(turnId, text);
  const claimed = claimTurnStatusProjection(turnId, Date.now());
  if (!claimed) return "permanent_failure" as const;
  if (claimed.slack_status_msg_ts) {
    await client.chat.update({ ts: claimed.slack_status_msg_ts, text: claimed.desired_text });
  } else {
    const posted = await client.chat.postMessage({
      thread_ts: claimed.slack_thread_ts,
      text: claimed.desired_text,
    });
    recordTurnStatusMessage(turnId, claimed.message_generation, posted.ts);
  }
  markTurnStatusProjectionDelivered(turnId, claimed.desired_revision);
  return "delivered" as const;
}

async function projectThreadSummary(channel: string, threadTs: string, turnId: number, text: string) {
  requestSlackThreadStatusProjection({ channel, threadTs, turnId, text });
  const claimed = claimSlackThreadStatusProjection(channel, threadTs, Date.now());
  if (!claimed) return "permanent_failure" as const;
  markSlackThreadStatusProjectionDelivered(channel, threadTs, claimed.desired_revision);
  return "delivered" as const;
}

describe("executeAgentTurn", () => {
  test.each([false, true])("uses one Agent progress stream, a separate final reply, and a terminal root summary (resuming=%s)", async (resuming) => {
    upsertChannel({
      slack_channel_id: "C-agent",
      slack_channel_name: "agent",
      group_name: null,
      name: "Agent",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "850.000001";
    const session = createOrGetSession("C-agent", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      rootThreadTs,
      "Build the Agent experience",
      "runtime-agent",
      undefined,
      rootThreadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    if (resuming) {
      beginTurnProgressStream(acquired.id);
      recordTurnProgressStreamStarted(acquired.id, "progress-1", "activity-before-retry");
    }
    const startedChunks: any[][] = [];
    const stoppedChunks: any[][] = [];
    const rootSummaries: string[] = [];
    let finalDeliveries = 0;
    let legacyStatusCalls = 0;
    let reactionCalls = 0;
    const agentSessionStatuses: string[] = [];
    const startupEffects: string[] = [];
    const client = {
      reactions: { add: async () => { reactionCalls += 1; return { ok: true }; } },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        startupEffects.push("provider.run");
        input.onProgress?.({ type: "started" });
        if (!resuming) input.onProgress?.({ type: "commentary", text: "Mapped the current lifecycle." });
        input.onProgress?.({
          type: "activity",
          itemId: "item-1",
          title: "Editing turn lifecycle",
          status: "in_progress",
        });
        input.onProgress?.({
          type: "plan",
          planTitle: "Implementation",
          title: "Step 2/3 · Add focused tests",
          status: "in_progress",
        });
        input.onProviderTerminal?.();
        return {
          text: "TL;DR: Agent streaming is implemented.\n\nFull result.",
          sessionUUID: "provider-agent",
          providerTurnId: "provider-turn-agent",
          durationMs: 1_122_000,
          toolsUsed: ["edit"],
        };
      },
      async fork() { throw new Error("not used"); },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        finalDeliveries += 1;
        markDeliveryChunkDelivered(turnId, 0, "final-1");
        return "delivered";
      },
      projectTurnStatus: async () => {
        legacyStatusCalls += 1;
        return "delivered";
      },
      projectThreadSummary: async () => {
        legacyStatusCalls += 1;
        return "delivered";
      },
      startAgentProgress: async ({ chunks }) => {
        startedChunks.push(chunks);
        startupEffects.push("progress.persisted");
        return "progress-1";
      },
      appendAgentProgress: async () => {},
      stopAgentProgress: async ({ chunks, turnId }) => {
        expect(db.query("SELECT provider_duration_ms FROM turns WHERE id=?").get(turnId))
          .toMatchObject({ provider_duration_ms: 1_122_000 });
        expect(finalDeliveries).toBe(0);
        stoppedChunks.push(chunks);
      },
      setAgentSessionStatus: async ({ status }) => {
        agentSessionStatuses.push(status);
        startupEffects.push(`session.${status}`);
      },
      projectRootSummary: async ({ text }) => {
        rootSummaries.push(text);
        return "delivered";
      },
    };
    const controller = new TurnSteeringController();
    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C-agent"),
      channelId: "C-agent",
      threadTs: rootThreadTs,
      userMsgTs: rootThreadTs,
      user: "U1",
      text: "Build the Agent experience",
      prompt: "Build the Agent experience",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-agent",
      projectionMode: "agent",
      recipientTeamId: "T1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
      statusIntervalMs: 1,
    });

    expect(outcome).toEqual({ status: "delivered", turnId: acquired.id });
    expect(startedChunks).toHaveLength(resuming ? 0 : 1);
    expect(stoppedChunks).toHaveLength(1);
    if (!resuming) expect(stoppedChunks[0]).toContainEqual({ type: "markdown_text", text: "Mapped the current lifecycle." });
    expect(stoppedChunks[0]).toContainEqual(expect.objectContaining({
      type: "task_update",
      title: "Work complete · 18m 42s",
      status: "complete",
      ...(resuming ? { id: "activity-before-retry" } : {}),
    }));
    expect(agentSessionStatuses).toEqual(["processing"]);
    expect(startupEffects).toEqual([...(resuming ? [] : ["progress.persisted"]), "session.processing", "provider.run"]);
    expect(finalDeliveries).toBe(1);
    expect(rootSummaries).toEqual([
      "Build the Agent experience\n\nConcierge TL;DR: Agent streaming is implemented.",
    ]);
    expect(legacyStatusCalls).toBe(0);
    expect(reactionCalls).toBe(0);
  });

  test("cancels only the running Agent turn and closes its progress stream without a final reply", async () => {
    upsertChannel({
      slack_channel_id: "C-stop",
      slack_channel_name: "stop",
      group_name: null,
      name: "Stop",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const threadTs = "860.000001";
    const session = createOrGetSession("C-stop", threadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      threadTs,
      "Long request",
      "runtime-stop",
      undefined,
      threadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    let cancellationReady!: () => void;
    const ready = new Promise<void>((resolve) => { cancellationReady = resolve; });
    const provider: AgentProvider = {
      id: "codex",
      run: (input) => new Promise((_resolve, reject) => {
        input.onCancellationReady?.(async () => {
          reject(new ProviderTurnCancelledError());
        });
        cancellationReady();
      }),
      async fork() { throw new Error("not used"); },
    };
    const stoppedChunks: any[][] = [];
    let finalDeliveries = 0;
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => { finalDeliveries += 1; return "delivered"; },
      projectTurnStatus: async () => "delivered",
      projectThreadSummary: async () => "delivered",
      startAgentProgress: async () => "progress-stop",
      appendAgentProgress: async () => {},
      stopAgentProgress: async ({ chunks }) => { stoppedChunks.push(chunks); },
      projectRootSummary: async () => "delivered",
    };
    const steering = new TurnSteeringController();
    const cancellation = new TurnCancellationController();
    const execution = executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C-stop"),
      channelId: "C-stop",
      threadTs,
      userMsgTs: threadTs,
      user: "U1",
      text: "Long request",
      prompt: "Long request",
      files: [],
      client: {},
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: threadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-stop",
      projectionMode: "agent",
      recipientTeamId: "T1",
      steeringController: steering,
      cancellationController: cancellation,
      closeSteering: (reason) => steering.close(reason),
      services,
    });
    await ready;
    await cancellation.request();
    expect(await execution).toEqual({ status: "cancelled", turnId: acquired.id });
    expect(stoppedChunks.flat()).toContainEqual(expect.objectContaining({
      type: "task_update",
      title: "Stopped",
      status: "complete",
    }));
    expect(finalDeliveries).toBe(0);
    expect(getSession("C-stop", threadTs, "codex").status).toBe("idle");
  });

  test("suspends the Agent session and tags the requester only for a terminal failure", async () => {
    upsertChannel({
      slack_channel_id: "C-agent-failure",
      slack_channel_name: "agent-failure",
      group_name: null,
      name: "Agent failure",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const threadTs = "870.000001";
    const session = createOrGetSession("C-agent-failure", threadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      threadTs,
      "Fail after admission",
      "runtime-agent-failure",
      undefined,
      threadTs,
      { userId: "U-requester", projectionMode: "agent" },
    );
    const sessionStatuses: string[] = [];
    const projectedStatuses: string[] = [];
    let reactionCalls = 0;
    let finalDeliveries = 0;
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "activity", itemId: "item-failure", title: "Running provider", status: "in_progress" });
        throw new Error("provider terminated unexpectedly");
      },
      async fork() { throw new Error("not used"); },
    };
    const steering = new TurnSteeringController();
    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C-agent-failure"),
      channelId: "C-agent-failure",
      threadTs,
      userMsgTs: threadTs,
      user: "U-requester",
      text: "Fail after admission",
      prompt: "Fail after admission",
      files: [],
      client: { reactions: { add: async () => { reactionCalls += 1; return { ok: true }; } } },
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: threadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-agent-failure",
      projectionMode: "agent",
      recipientTeamId: "T1",
      steeringController: steering,
      closeSteering: (reason) => steering.close(reason),
      services: {
        hydrateLegacyThreadOwnership: async () => 0,
        deliverOutcome: async () => { finalDeliveries += 1; return "delivered"; },
        projectTurnStatus: async ({ text }) => { projectedStatuses.push(text); return "delivered"; },
        projectThreadSummary: async () => "delivered",
        startAgentProgress: async () => "progress-failure",
        appendAgentProgress: async () => {},
        stopAgentProgress: async () => {},
        setAgentSessionStatus: async ({ status }) => { sessionStatuses.push(status); },
        projectRootSummary: async () => "delivered",
      },
    });

    expect(outcome.status).toBe("error");
    expect(sessionStatuses).toEqual(["processing", "suspended"]);
    expect(projectedStatuses).toHaveLength(1);
    expect(projectedStatuses[0]).toStartWith("<@U-requester>");
    expect(finalDeliveries).toBe(0);
    expect(reactionCalls).toBe(0);
  });

  test("delivers the provider turn without reading the channel AGENTS.md", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    mkdirSync(join(projectDir, "AGENTS.md"));
    const rootThreadTs = "900.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "900.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    let providerCalled = false;
    let closeSteeringCalls = 0;
    const providerSessionBindings: string[] = [];
    const statusTexts: string[] = [];
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async (args: any) => {
          statusTexts.push(args.text);
          return { ok: true, ts: "status-error" };
        },
        update: async (args: any) => {
          statusTexts.push(args.text);
          return { ok: true };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        providerCalled = true;
        input.onProgress?.({ type: "started" });
        input.onProviderTerminal?.();
        return {
          text: "TL;DR: Provider work completed.\n\nResponse body.",
          sessionUUID: "provider-session",
          providerTurnId: "provider-turn",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, "response-1");
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: ({ channel, threadTs, turnId, text }) => projectThreadSummary(
        channel,
        threadTs,
        turnId,
        text,
      ),
      providerSessionBound: async (providerThreadUuid) => {
        providerSessionBindings.push(providerThreadUuid);
      },
    };
    const controller = new TurnSteeringController();
    const outcome = await executeAgentTurn({
        turnId: acquired.id,
        session,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs: rootThreadTs,
        userMsgTs: "900.000010",
        user: "U1",
        text: "request",
        prompt: "request",
        files: [],
        client,
        provider,
        providerId: "codex",
        providerLabel: "Codex",
        sessionThreadTs: rootThreadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController: controller,
        closeSteering: (reason) => {
          closeSteeringCalls += 1;
          controller.close(reason);
        },
        services,
    });

    expect(outcome!.status).toBe("delivered");
    expect(providerCalled).toBeTrue();
    expect(providerSessionBindings).toEqual(["provider-session"]);
    expect(closeSteeringCalls).toBeGreaterThan(0);
    expect(statusTexts.some((text) => text.includes("Status: done"))).toBeTrue();
    expect(db.query("SELECT status FROM turns WHERE id=?").get(acquired.id)).toMatchObject({ status: "done" });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
  });

  test("explicitly parks terminal status state when its projection throws", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    mkdirSync(join(projectDir, "AGENTS.md"));
    const rootThreadTs = "925.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "925.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-projection-error" }),
        update: async () => ({ ok: true }),
      },
    };
    let projectionCallCount = 0;
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => "delivered",
      projectTurnStatus: ({ turnId, text }) => {
        projectionCallCount += 1;
        if (projectionCallCount > 1) throw new Error("status worker crashed");
        return projectTurnStatus(client, turnId, text);
      },
      projectThreadSummary: async () => "delivered",
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        const stagingDirectory = getTurnArtifactBatch(acquired.id).directory_path;
        writeFileSync(join(stagingDirectory, "failed-turn.txt"), "temporary");
        throw new Error("provider failed");
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "925.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("error");
    expect(outcome).toMatchObject({ error: "Error: provider failed" });
    expect(db.query(`
      SELECT status, status_projection_status, status_desired_text, status_projection_error
      FROM turns WHERE id=?
    `).get(acquired.id)).toMatchObject({
      status: "error",
      status_projection_status: "parked",
    });
    expect(String((db.query("SELECT status_desired_text FROM turns WHERE id=?")
      .get(acquired.id) as any).status_desired_text)).toContain("Status: error");
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("error");
    expect(getTurnArtifactBatch(acquired.id)).toMatchObject({ status: "abandoned" });
    expect(existsSync(getTurnArtifactBatch(acquired.id).directory_path)).toBeFalse();
  });

  test("cleans downloaded attachments when provider preparation fails", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "940.000001";
    const userMsgTs = "940.000010";
    const attachmentDir = join(tmpdir(), "inbox-attachments", "C1", userMsgTs);
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      userMsgTs,
      "transcribe this",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    let providerCalled = false;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-attachment-error" }),
        update: async () => ({ ok: true }),
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run() {
        providerCalled = true;
        throw new Error("provider must not run");
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => "delivered",
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
    };
    const controller = new TurnSteeringController();
    const originalFetch = globalThis.fetch;
    let outcome: Awaited<ReturnType<typeof executeAgentTurn>> | undefined;
    try {
      globalThis.fetch = (async () => new Response("not audio")) as typeof fetch;
      outcome = await executeAgentTurn({
        turnId: acquired.id,
        session,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs: rootThreadTs,
        userMsgTs,
        user: "U1",
        text: "transcribe this",
        prompt: "transcribe this",
        files: [{
          name: "clip.wav",
          mimetype: "audio/wav",
          url_private_download: "https://files.slack.test/clip.wav",
        }],
        client,
        provider,
        providerId: "codex",
        providerLabel: "Codex",
        sessionThreadTs: rootThreadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController: controller,
        closeSteering: (reason) => controller.close(reason),
        services,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(outcome?.status).toBe("error");
    expect(providerCalled).toBeFalse();
    expect(existsSync(attachmentDir)).toBeFalse();
  });

  test("relinquishes recoverable delivery when execution fails after delivery begins", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "950.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "950.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    const statusTexts: string[] = [];
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async (args: any) => {
          statusTexts.push(args.text);
          return { ok: true, ts: "status-delivery-error" };
        },
        update: async (args: any) => {
          statusTexts.push(args.text);
          return { ok: true };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        return {
          text: "TL;DR: Prepared the response.\n\nResponse body.",
          sessionUUID: "provider-session",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => {
        throw new Error("delivery failed after durable delivery intent");
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "950.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("delivery_stopped");
    expect(db.query("SELECT status, delivery_status FROM turns WHERE id=?").get(acquired.id)).toMatchObject({
      status: "delivering",
      delivery_status: "pending",
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("running");
    expect(listRecoverableTurns().map((turn: any) => turn.id)).toContain(acquired.id);
    expect(statusTexts.some((text) => text.includes("Status: error"))).toBeTrue();
  });

  test("keeps the hourglass while response delivery remains recoverable", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "960.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "960.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    let removedReactions = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => {
          removedReactions += 1;
          return { ok: true };
        },
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-delivery-stopped" }),
        update: async () => ({ ok: true }),
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        return {
          text: "TL;DR: Delivery is pending.\n\nResponse body.",
          sessionUUID: "provider-session",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => "stopped",
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "960.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("delivery_stopped");
    expect(removedReactions).toBe(0);
    expect(db.query("SELECT turn_id FROM turn_reaction_cleanups WHERE turn_id=?")
      .get(acquired.id)).toBeNull();
    expect(db.query("SELECT status, delivery_status FROM turns WHERE id=?").get(acquired.id)).toMatchObject({
      status: "delivering",
      delivery_status: "pending",
    });
  });

  test("parks explicit permanent delivery failure before terminal projection can stop", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "970.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "970.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-permanent-delivery" }),
        update: async () => ({ ok: true }),
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        return {
          text: "TL;DR: Slack rejected delivery.\n\nResponse body.",
          sessionUUID: "provider-session",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    let statusProjectionCalls = 0;
    let statusObservedByTerminalProjection: string | null = null;
    let durableTerminalProjection: any = null;
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => "permanent_failure",
      projectTurnStatus: async ({ turnId, text }) => {
        statusProjectionCalls += 1;
        if (statusProjectionCalls === 1) return projectTurnStatus(client, turnId, text);
        statusObservedByTerminalProjection = (db.query("SELECT status FROM turns WHERE id=?")
          .get(turnId) as { status: string }).status;
        durableTerminalProjection = getTurnStatusProjection(turnId);
        return "stopped";
      },
      projectThreadSummary: async () => "delivered",
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "970.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("delivery_parked");
    expect(statusObservedByTerminalProjection).toBe("delivery_parked");
    expect(durableTerminalProjection).toMatchObject({
      projection_status: "pending",
      desired_revision: 2,
    });
    expect(durableTerminalProjection.desired_text).toContain(
      "Status: error - response delivery was permanently parked",
    );
    expect(db.query(`
      SELECT status, delivery_status, owner_instance_id FROM turns WHERE id=?
    `).get(acquired.id)).toMatchObject({
      status: "delivery_parked",
      delivery_status: "parked",
      owner_instance_id: null,
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
  });

  test("keeps a delivered response complete when terminal projections throw", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "975.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "975.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-projection-failure" }),
        update: async () => ({ ok: true }),
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        return {
          text: "TL;DR: Delivered safely.\n\nResponse body.",
          sessionUUID: "provider-session",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    let turnProjectionCalls = 0;
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, "response-delivered");
        return "delivered";
      },
      projectTurnStatus: async ({ turnId, text }) => {
        turnProjectionCalls += 1;
        if (turnProjectionCalls > 1) throw new Error("terminal turn projection crashed");
        return projectTurnStatus(client, turnId, text);
      },
      projectThreadSummary: async () => {
        throw new Error("cumulative summary projection crashed");
      },
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "975.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("delivered");
    expect(db.query(`
      SELECT status, delivery_status, status_projection_status FROM turns WHERE id=?
    `).get(acquired.id)).toMatchObject({
      status: "done",
      delivery_status: "delivered",
      status_projection_status: "parked",
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
    expect(getSlackThreadStatus("C1", rootThreadTs)).toMatchObject({
      projection_status: "parked",
      summary_through_turn_id: acquired.id,
    });
  });

  test("gives every follow-up its own heartbeat while retaining one cumulative thread summary", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: null,
    });
    const rootThreadTs = "1000.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const slackEvents: Array<{ kind: string; ts?: string; text?: string; threadTs?: string }> = [];
    const providerSystemPrompts: Array<string | undefined> = [];
    const heartbeatResolvers: Array<() => void> = [];
    const heartbeatPromises = [0, 1].map((index) => new Promise<void>((resolve) => {
      heartbeatResolvers[index] = resolve;
    }));
    let statusCount = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async (args: any) => {
          const ts = `status-${++statusCount}`;
          slackEvents.push({ kind: "status-created", ts, text: args.text, threadTs: args.thread_ts });
          return { ok: true, ts };
        },
        update: async (args: any) => {
          slackEvents.push({ kind: "status-updated", ts: args.ts, text: args.text });
          if (String(args.text).includes("Status: working")) {
            heartbeatResolvers[Number(String(args.ts).split("-")[1]) - 1]?.();
          }
          return { ok: true };
        },
      },
    };
    let providerTurn = 0;
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        const index = providerTurn++;
        providerSystemPrompts.push(input.systemPrompt);
        input.onProgress?.({ type: "started" });
        input.onProgress?.({ type: "tool_use", toolName: "exec" });
        await Promise.race([
          heartbeatPromises[index],
          new Promise((_, reject) => setTimeout(() => reject(new Error("heartbeat did not arrive")), 1_000)),
        ]);
        return {
          text: index === 0
            ? "TL;DR: Completed the first request.\n\nFirst response."
            : "TL;DR: Completed the first request and its follow-up.\n\nSecond response.",
          sessionUUID: "provider-session",
          toolsUsed: ["exec"],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        slackEvents.push({ kind: "response-delivered" });
        markDeliveryChunkDelivered(turnId, 0, `response-${turnId}`);
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async ({ channel, threadTs, turnId, text }) => {
        requestSlackThreadStatusProjection({ channel, threadTs, turnId, text });
        const claimed = claimSlackThreadStatusProjection(channel, threadTs, Date.now());
        if (!claimed) return "permanent_failure";
        await client.chat.update({ ts: claimed.slack_status_msg_ts, text: claimed.desired_text });
        markSlackThreadStatusProjectionDelivered(channel, threadTs, claimed.desired_revision);
        return "delivered";
      },
    };

    const runTurn = async (userMsgTs: string, text: string) => {
      const currentSession = getSession("C1", rootThreadTs, "codex");
      const acquired = acquireSessionTurn(
        currentSession.id,
        userMsgTs,
        text,
        "runtime-1",
        undefined,
        rootThreadTs,
      );
      expect(acquired.acquired).toBeTrue();
      const controller = new TurnSteeringController();
      return executeAgentTurn({
        turnId: acquired.id,
        session: currentSession,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs: rootThreadTs,
        userMsgTs,
        user: "U1",
        text,
        prompt: text,
        files: [],
        client,
        provider,
        providerId: "codex",
        providerLabel: "Codex",
        sessionThreadTs: rootThreadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController: controller,
        closeSteering: (reason) => controller.close(reason),
        services,
        statusIntervalMs: 5,
      });
    };

    expect((await runTurn("1000.000010", "First request")).status).toBe("delivered");
    const firstTurnEventCount = slackEvents.length;
    expect((await runTurn("1000.000020", "Follow-up request")).status).toBe("delivered");

    const creations = slackEvents.filter((event) => event.kind === "status-created");
    expect(creations.map((event) => event.ts)).toEqual(["status-1", "status-2"]);
    expect(creations.every((event) => event.threadTs === rootThreadTs)).toBeTrue();
    for (const statusTs of ["status-1", "status-2"]) {
      expect(slackEvents.some((event) =>
        event.kind === "status-updated" && event.ts === statusTs && event.text?.includes("Status: working")
      )).toBeTrue();
    }
    const secondTurnEvents = slackEvents.slice(firstTurnEventCount);
    expect(secondTurnEvents.some((event) =>
      event.kind === "status-updated" && event.ts === "status-1" && event.text?.includes("Status: working")
    )).toBeFalse();

    const threadStatus = getSlackThreadStatus("C1", rootThreadTs);
    expect(threadStatus.slack_status_msg_ts).toBe("status-1");
    expect(threadStatus.thread_tldr).toBe("Completed the first request and its follow-up.");
    expect(slackEvents.some((event) =>
      event.kind === "status-updated" &&
      event.ts === "status-1" &&
      event.text?.includes("Completed the first request and its follow-up.")
    )).toBeTrue();
    expect(slackEvents.some((event) =>
      event.kind === "status-updated" &&
      event.ts === "status-2" &&
      event.text?.includes("Completed the first request and its follow-up.")
    )).toBeTrue();
    const turnStatuses = db.query(`
      SELECT slack_bot_msg_ts, status_projection_status, status_desired_text
      FROM turns ORDER BY id
    `).all();
    expect(turnStatuses.map((row: any) => row.slack_bot_msg_ts)).toEqual(["status-1", "status-2"]);
    expect(turnStatuses.every((row: any) => row.status_projection_status === "delivered")).toBeTrue();
    expect(turnStatuses.every((row: any) => row.status_desired_text.includes("Status: done"))).toBeTrue();
    expect(providerSystemPrompts[0]).toContain(CONCIERGE_SESSION_RESPONSE_CONTRACT);
    expect(providerSystemPrompts[1]).toContain(CONCIERGE_SESSION_RESPONSE_CONTRACT);
    expect(providerSystemPrompts[0]).not.toContain("Prior delivered summaries for this visible Slack thread");
    expect(providerSystemPrompts[1]).toContain("Prior delivered summaries for this visible Slack thread");
    expect(providerSystemPrompts[1]).toContain("Completed the first request.");
    expect(providerSystemPrompts.every((prompt) => prompt?.includes("Slack artifact delivery for this turn:"))).toBeTrue();
    expect(providerSystemPrompts.every((prompt) => !prompt?.includes("Slack List context"))).toBeTrue();
  });

  test("awaits durable artifacts before settling and promoting a queued successor", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const threadTs = "1050.000001";
    const session = createOrGetSession("C1", threadTs, "codex");
    const first = acquireSessionTurn(
      session.id,
      "1050.000010",
      "produce an artifact",
      "runtime-1",
      undefined,
      threadTs,
    );
    const second = acquireSessionTurn(
      session.id,
      "1050.000020",
      "queued successor",
      "runtime-1",
      undefined,
      threadTs,
    );
    expect(first.acquired).toBeTrue();
    expect(second.queued).toBeTrue();

    let uploadStarted!: () => void;
    const uploadStartedPromise = new Promise<void>((resolve) => { uploadStarted = resolve; });
    let finishUpload!: () => void;
    const uploadMayFinish = new Promise<void>((resolve) => { finishUpload = resolve; });
    let successorStarted!: () => void;
    const successorStartedPromise = new Promise<void>((resolve) => { successorStarted = resolve; });
    let statusCount = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: `status-${++statusCount}` }),
        update: async () => ({ ok: true }),
      },
      files: {
        uploadV2: async (args: any) => {
          for await (const _chunk of args.file) {}
          uploadStarted();
          await uploadMayFinish;
          return { ok: true, files: [{ id: "F_ARTIFACT" }] };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        const artifactDirectory = getTurnArtifactBatch(first.id).directory_path;
        writeFileSync(join(artifactDirectory, "result.txt"), "durable result");
        input.onProviderTerminal?.();
        return {
          text: "TL;DR: Produced the requested artifact.\n\nResponse body.",
          sessionUUID: "provider-session",
          providerTurnId: "provider-turn",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, "response-first");
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: ({ channel, threadTs, turnId, text }) => projectThreadSummary(
        channel,
        threadTs,
        turnId,
        text,
      ),
    };
    let firstSettled = false;
    let successorWasStarted = false;
    const coordinator = new SessionTurnQueueCoordinator({
      claim: () => claimNextQueuedTurn("runtime-1"),
      run: async () => {
        successorWasStarted = true;
        successorStarted();
      },
      shouldStop: () => false,
      onError: (_claim, error) => { throw error; },
    });
    const registry = new ActiveTurnDispatchRegistry({
      onStarted: () => {},
      onSettled: () => coordinator.wake(),
    });
    const firstExecution = registry.run(
      { turnId: first.id, channelId: "C1", threadTs },
      (steeringController, closeSteering) => executeAgentTurn({
        turnId: first.id,
        session,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs,
        userMsgTs: "1050.000010",
        user: "U1",
        text: "produce an artifact",
        prompt: "produce an artifact",
        files: [],
        client,
        provider,
        providerId: "codex",
        providerLabel: "Codex",
        sessionThreadTs: threadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController,
        closeSteering,
        services,
      }),
    ).then((outcome) => {
      firstSettled = true;
      return outcome;
    });

    await uploadStartedPromise;
    const arrivingDuringUpload = acquireSessionTurn(
      session.id,
      "1050.000030",
      "arrives during artifact upload",
      "runtime-1",
      undefined,
      threadTs,
    );
    expect(arrivingDuringUpload.queued).toBeTrue();
    coordinator.wake();
    await Promise.resolve();
    expect(firstSettled).toBeFalse();
    expect(successorWasStarted).toBeFalse();
    finishUpload();
    expect((await firstExecution).status).toBe("delivered");
    await successorStartedPromise;
    expect(successorWasStarted).toBeTrue();
  });

  test("routes two overlapping turns' artifacts symmetrically when they finish in opposite order", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const unrelatedThreadTs = "1100.000001";
    const producingThreadTs = "1200.000001";
    const unrelatedSession = createOrGetSession("C1", unrelatedThreadTs, "codex");
    const producingSession = createOrGetSession("C1", producingThreadTs, "codex");
    const unrelatedTurn = acquireSessionTurn(
      unrelatedSession.id,
      "1100.000010",
      "unrelated long turn",
      "runtime-1",
      undefined,
      unrelatedThreadTs,
    );
    const producingTurn = acquireSessionTurn(
      producingSession.id,
      "1200.000010",
      "produce manifest",
      "runtime-1",
      undefined,
      producingThreadTs,
    );
    expect(unrelatedTurn.acquired).toBeTrue();
    expect(producingTurn.acquired).toBeTrue();

    let releaseUnrelatedProvider: () => void = () => {};
    const unrelatedProviderReleased = new Promise<void>((resolve) => {
      releaseUnrelatedProvider = resolve;
    });
    let markUnrelatedProviderStarted: () => void = () => {};
    const unrelatedProviderStarted = new Promise<void>((resolve) => {
      markUnrelatedProviderStarted = resolve;
    });
    const uploads: Array<{ threadTs: string; filename: string }> = [];
    let statusCount = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: `status-${++statusCount}` }),
        update: async () => ({ ok: true }),
      },
      files: {
        uploadV2: async (args: any) => {
          for await (const _chunk of args.file) {}
          uploads.push({ threadTs: args.thread_ts, filename: args.filename });
          return { ok: true, files: [{ id: `file-${uploads.length}` }] };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        if (input.prompt === "unrelated long turn") {
          const unrelatedDirectory = getTurnArtifactBatch(unrelatedTurn.id).directory_path;
          expect(input.systemPrompt).toContain(JSON.stringify(unrelatedDirectory));
          writeFileSync(join(unrelatedDirectory, "unrelated.txt"), "unrelated");
          markUnrelatedProviderStarted();
          await unrelatedProviderReleased;
        } else {
          const producingDirectory = getTurnArtifactBatch(producingTurn.id).directory_path;
          expect(input.systemPrompt).toContain(JSON.stringify(producingDirectory));
          writeFileSync(join(producingDirectory, "slack-app-manifest.json"), "{}");
          writeFileSync(join(projectDir, ".artifacts", "legacy-shared-root.txt"), "must be ignored");
        }
        return {
          text: `TL;DR: Completed ${input.prompt}.\n\nResponse body.`,
          sessionUUID: `provider-${input.prompt}`,
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, `response-${turnId}`);
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
    };
    const execute = (
      turn: typeof unrelatedTurn,
      session: typeof unrelatedSession,
      threadTs: string,
      userMsgTs: string,
      prompt: string,
    ) => {
      const controller = new TurnSteeringController();
      return executeAgentTurn({
        turnId: turn.id,
        session,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs,
        userMsgTs,
        user: "U1",
        text: prompt,
        prompt,
        files: [],
        client,
        provider,
        providerId: "codex",
        providerLabel: "Codex",
        sessionThreadTs: threadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController: controller,
        closeSteering: (reason) => controller.close(reason),
        services,
      });
    };

    const unrelatedOutcome = execute(
      unrelatedTurn,
      unrelatedSession,
      unrelatedThreadTs,
      "1100.000010",
      "unrelated long turn",
    );
    await unrelatedProviderStarted;
    const producingOutcome = await execute(
      producingTurn,
      producingSession,
      producingThreadTs,
      "1200.000010",
      "produce manifest",
    );
    releaseUnrelatedProvider();

    expect(producingOutcome.status).toBe("delivered");
    expect((await unrelatedOutcome).status).toBe("delivered");
    expect(uploads).toEqual([
      { threadTs: producingThreadTs, filename: "slack-app-manifest.json" },
      { threadTs: unrelatedThreadTs, filename: "unrelated.txt" },
    ]);
  });

  test("runs a deployment wake as a reaction-free turn with native deployment context", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "1300.000001";
    upsertSession("C1", rootThreadTs, "codex", "provider-existing", { status: "running" });
    const session = getSession("C1", rootThreadTs, "codex");
    const priorTurn = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_bot_msg_ts, slack_reply_thread_ts,
      user_text, agent_text, response_tldr, status, delivery_status
    ) VALUES (?, '1300.000010', 'status-prior', ?, 'implement wake',
      'TL;DR: Implemented the deployment wake.', 'Implemented the deployment wake.',
      'done', 'delivered') RETURNING id`).get(session.id, rootThreadTs) as { id: number };
    db.query(`INSERT INTO slack_thread_statuses (
      slack_channel_id, slack_thread_ts, slack_status_msg_ts, anchor_turn_id,
      thread_tldr, summary_through_turn_id
    ) VALUES ('C1', ?, 'status-prior', ?, 'Implemented the deployment wake.', ?)`)
      .run(rootThreadTs, priorTurn.id, priorTurn.id);
    const turn = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status,
      owner_instance_id, turn_kind, trigger_key
    ) VALUES (?, 'deployment:wake-1', ?, 'verify live deployment', 'running',
      'runtime-verifier', 'deployment_verification', 'wake-1') RETURNING id`)
      .get(session.id, rootThreadTs) as { id: number };
    let reactionCalls = 0;
    let cleanupCalls = 0;
    let admissionIntentCalls = 0;
    let providerInput: any = null;
    const statusUpdates: Array<{ ts: string; text: string }> = [];
    let releaseHeartbeat: () => void = () => {};
    const heartbeat = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
    const client = {
      reactions: {
        add: async () => { reactionCalls += 1; return { ok: true }; },
        remove: async () => { reactionCalls += 1; return { ok: true }; },
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-deployment" }),
        update: async (args: any) => {
          statusUpdates.push({ ts: args.ts, text: args.text });
          if (args.ts === "status-deployment" && String(args.text).includes("Status: working")) {
            releaseHeartbeat();
          }
          return { ok: true };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        providerInput = input;
        input.onProgress?.({ type: "started" });
        input.onProgress?.({ type: "tool_use", toolName: "exec" });
        await Promise.race([
          heartbeat,
          new Promise((_, reject) => setTimeout(() => reject(new Error("heartbeat did not arrive")), 1_000)),
        ]);
        return {
          text: "TL;DR: Implemented the deployment wake and verified it live.\n\nVerified against the running service.",
          sessionUUID: "provider-existing",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, "verification-response");
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async ({ channel, threadTs, turnId, text }) => {
        requestSlackThreadStatusProjection({ channel, threadTs, turnId, text });
        const claimed = claimSlackThreadStatusProjection(channel, threadTs, Date.now());
        if (!claimed) return "permanent_failure";
        await client.chat.update({ ts: claimed.slack_status_msg_ts, text: claimed.desired_text });
        markSlackThreadStatusProjectionDelivered(channel, threadTs, claimed.desired_revision);
        return "delivered";
      },
      scheduleWorkingReactionCleanup: async () => { cleanupCalls += 1; },
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: turn.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "deployment:wake-1",
      user: "U1",
      text: "verify live deployment",
      prompt: "verify live deployment",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-verifier",
      turnKind: "deployment_verification",
      providerEnvironment: {
        CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
        CONCIERGE_DEPLOYMENT_WAKE_ID: "wake-1",
      },
      beforeProviderAdmission: () => { admissionIntentCalls += 1; },
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
      statusIntervalMs: 5,
    });

    expect(outcome.status).toBe("delivered");
    expect(reactionCalls).toBe(0);
    expect(cleanupCalls).toBe(0);
    expect(admissionIntentCalls).toBe(1);
    expect(providerInput.sessionUUID).toBe("provider-existing");
    expect(providerInput.environment).toMatchObject({
      CONCIERGE_TURN_ID: String(turn.id),
      CONCIERGE_SESSION_ID: String(session.id),
      CONCIERGE_TURN_KIND: "deployment_verification",
      CONCIERGE_OWNER_INSTANCE_ID: "runtime-verifier",
      CONCIERGE_SLACK_CHANNEL_ID: "C1",
      CONCIERGE_SLACK_THREAD_TS: rootThreadTs,
      CONCIERGE_COMMIT_PROVENANCE: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
      CONCIERGE_DEPLOYMENT_WAKE_ID: "wake-1",
    });
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toMatchObject({ status: "done" });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
    expect(getSlackThreadStatus("C1", rootThreadTs)).toMatchObject({
      slack_status_msg_ts: "status-prior",
      thread_tldr: "Implemented the deployment wake and verified it live.",
      summary_through_turn_id: turn.id,
    });
    expect(statusUpdates.some((update) =>
      update.ts === "status-deployment" && update.text.includes("Status: working")
    )).toBeTrue();
    expect(statusUpdates.some((update) =>
      update.ts === "status-prior" && update.text.includes("Status: working")
    )).toBeFalse();
  });
});
